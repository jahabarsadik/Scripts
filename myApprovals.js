const express = require('express');
const { query, getConnection } = require('../../services/db');
const cbgmMail = require('../../services/cbgm/cbgmMail');
const onboardAlerts = require('../../services/cbgm/onboardAlerts');
const tier2Requests = require('../../services/cbgm/tier2Requests');
const alertReviewers = require('../../services/cbgm/alertReviewers');

// CBGM My Approval: requests waiting for the logged-in user (1bank ID = req.user.username)
//   Update Threshold     : config_service_threshold_history.approved_by = me AND approval_status = 'Open'
//   New Alert Onboarding : step 1 (stage 'sre')  alert_onboard_request.sre_lead_id -> cbgm_sre_lead_apps.id whose
//                          sre_lead_id = me, AND sre_lead_approval_status is 'Open' or empty
//                          step 2 (stage 'cbgm') me is a CBGM reviewer (config.js CBGMAlertReviewer, active portal user)
//                          AND sre_lead_approval_status = 'Approved' AND cbgm_approval_status is 'Open' or empty
//   Tier-2 Journey       : c2e_mtj_journey_app_request.approver_1bank_id = me AND approver_status 'Open' (me in config
//                          MTJ_Tier2_Checker); Approved Add -> the row is added to c2e_mtj_journey_app, approved Edit ->
//                          that journey (journey_id) is updated; Rejected needs remarks
//                          (approver_remarks); the requesters get one email with every decision
// Approve / Reject sets the status (and time) on that row; only the assigned approver can decide, and only once.
//   Threshold:  approval_status 'Approved' | 'Rejected', approved_time = NOW(); when approved, the new values are
//               written to config_service_threshold (change_by = approver, change_time = NOW()) in the same transaction
//   Onboarding step 1: sre_lead_approval_status 'Approved' | 'Rejected', sre_lead_remarks (required to reject), sre_lead_approval_time = NOW()
//   Onboarding step 2: cbgm_approval_status 'Approved' | 'Rejected', cbgm_approver_remarks (required to reject),
//                      cbgm_approval_id = reviewer's cbgm_portal_users.id, cbgm_approval_time = NOW();
//                      Approved (with a threshold) -> alert_criteria + config_service_threshold rows (services/cbgm/onboardAlerts.js)
//                      and an "onboarded successfully" email
const router = express.Router();

const DECISIONS = { approve: 'Approved', reject: 'Rejected' };

const fmt = (col) => `DATE_FORMAT(${col}, '%Y-%m-%d %H:%i')`;

function thresholdApprovals(me) {
  return query(
    `SELECT h.id, h.threshold_id, h.app_code, h.service_name, h.peak_hours, h.config_header,
            t.alert_type, t.alert_level,
            h.old_low_conservative_points AS old_low, h.new_low_conservative_points AS new_low,
            h.old_failure_percent AS old_failure, h.new_failure_percent AS new_failure,
            h.old_high_conservative_point AS old_high, h.new_high_conservative_point AS new_high,
            h.approval_status, h.request_by, COALESCE(NULLIF(u.USERNAME, ''), h.request_by) AS requester_name,
            ${fmt('h.change_time')} AS requested_time
       FROM config_service_threshold_history h
       LEFT JOIN config_service_threshold t ON t.id = h.threshold_id
       LEFT JOIN user u ON u.LOGINID = h.request_by
      WHERE LOWER(h.approved_by) = LOWER(?) AND LOWER(h.approval_status) = 'open'
      ORDER BY h.change_time DESC, h.id DESC`,
    [me]
  );
}

// Columns shared by both onboarding steps (SRE Lead name / decision included for the CBGM reviewer)
const ONBOARDING_SELECT = `SELECT r.id, s.app_code, di.index_name, sm.service_name,
            r.alert_type, r.alert_level, r.consecutive_points, r.operator, r.threshold, r.snoc_flag, r.remarks,
            r.sre_lead_approval_status AS approval_status,
            s.sre_lead_id AS sre_lead,
            COALESCE(NULLIF(TRIM(CONCAT_WS(' ', lp.first_name, lp.last_name)), ''), NULLIF(lu.USERNAME, ''), s.sre_lead_id) AS sre_lead_name,
            COALESCE(NULLIF(r.sre_lead_approval_status, ''), 'Open') AS sre_status,
            ${fmt('r.sre_lead_approval_time')} AS sre_time, r.sre_lead_remarks,
            COALESCE(NULLIF(TRIM(CONCAT_WS(' ', pu.first_name, pu.last_name)), ''), pu.\`1bank_id\`) AS requester_name,
            pu.\`1bank_id\` AS request_by, ${fmt('r.requested_time')} AS requested_time
       FROM alert_onboard_request r
       JOIN cbgm_sre_lead_apps s ON s.id = r.sre_lead_id
       LEFT JOIN cbgm_portal_users lp ON lp.\`1bank_id\` = s.sre_lead_id
       LEFT JOIN user lu ON lu.LOGINID = s.sre_lead_id
       LEFT JOIN cbgm_daily_service_monitoring sm ON sm.id = r.service_id
       LEFT JOIN cbgm_daily_index di ON di.id = sm.index_id
       LEFT JOIN cbgm_portal_users pu ON pu.id = r.requested_by`;
const NOT_DECIDED = (col) => `(${col} IS NULL OR ${col} = '' OR LOWER(${col}) = 'open')`;

/** Step 1: requests waiting for me as SRE Lead */
async function onboardingApprovals(me) {
  const rows = await query(
    `${ONBOARDING_SELECT}
      WHERE LOWER(s.sre_lead_id) = LOWER(?) AND ${NOT_DECIDED('r.sre_lead_approval_status')}
      ORDER BY r.requested_time DESC, r.id DESC`,
    [me]
  );
  return rows.map((r) => ({ ...r, stage: 'sre' }));
}

/** cbgm_portal_users.id of me when I am a CBGM reviewer (config.js CBGMAlertReviewer, active portal user), else null */
const reviewerId = (me) => alertReviewers.portalId(me);

/** Step 2: SRE-Lead-approved requests waiting for a CBGM reviewer (only when I am one) */
async function reviewApprovals(me) {
  if (!(await reviewerId(me))) return [];
  const rows = await query(
    `${ONBOARDING_SELECT}
      WHERE LOWER(r.sre_lead_approval_status) = 'approved' AND ${NOT_DECIDED('r.cbgm_approval_status')}
      ORDER BY r.sre_lead_approval_time DESC, r.id DESC`
  );
  return rows.map((r) => ({ ...r, stage: 'cbgm' }));
}

// GET /api/cbgm/my-approvals -> { threshold: [...], onboarding: [...] }
/** Tier-2 Journey requests waiting for me; [] when the request table is not ready (app_code column missing) */
const tier2Approvals = (me) => tier2Requests.waitingFor(me).catch((err) => {
  const problem = tier2Requests.setupProblem(err);
  if (!problem) throw err;
  console.error(`My Approval (Tier-2 Journey): ${problem}`);
  return [];
});

// GET /api/cbgm/my-approvals/count -> { total, threshold, onboarding, tier2 }: how many requests wait for this user
// (the number on the My Approval menu items)
router.get('/count', async (req, res, next) => {
  try {
    const me = req.user.username;
    const [threshold, sre, review, tier2] = await Promise.all([thresholdApprovals(me), onboardingApprovals(me), reviewApprovals(me), tier2Approvals(me)]);
    const n = { threshold: threshold.length, onboarding: sre.length + review.length, tier2: tier2.length };
    res.json({ total: n.threshold + n.onboarding + n.tier2, ...n });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const me = req.user.username;
    const [threshold, sre, review, tier2] = await Promise.all([thresholdApprovals(me), onboardingApprovals(me), reviewApprovals(me), tier2Approvals(me)]);
    res.json({ threshold, onboarding: [...sre, ...review], tier2 });
  } catch (err) {
    next(err);
  }
});

/** Record one decision inside an open transaction (the caller has checked it is still waiting for `me`). */
async function decide(conn, type, id, status, me, remarks, stage, reviewer) {
  if (type === 'tier2') return tier2Requests.decide(conn, id, status, me, remarks);
  if (type === 'threshold') {
    const done = await conn.query(
      `UPDATE config_service_threshold_history SET approval_status = ?, approved_time = NOW()
        WHERE id = ? AND LOWER(approved_by) = LOWER(?) AND LOWER(approval_status) = 'open'`,
      [status, id, me]
    );
    if (done.affectedRows && status === DECISIONS.approve) {
      await conn.query(
        `UPDATE config_service_threshold t
           JOIN config_service_threshold_history h ON h.threshold_id = t.id
            SET t.low_conservative_points = h.new_low_conservative_points,
                t.failure_percent = h.new_failure_percent,
                t.high_conservative_point = h.new_high_conservative_point,
                t.change_by = ?, t.change_time = NOW()
          WHERE h.id = ?`,
        [me, id]
      );
    }
    return done.affectedRows;
  }
  if (stage === 'cbgm') {
    const done = await conn.query(
      `UPDATE alert_onboard_request
          SET cbgm_approval_status = ?, cbgm_approver_remarks = ?, cbgm_approval_id = ?, cbgm_approval_time = NOW()
        WHERE id = ? AND LOWER(sre_lead_approval_status) = 'approved' AND ${NOT_DECIDED('cbgm_approval_status')}`,
      [status, remarks || null, reviewer, id]
    );
    return done.affectedRows;
  }
  const done = await conn.query(
    `UPDATE alert_onboard_request SET sre_lead_approval_status = ?, sre_lead_remarks = ?, sre_lead_approval_time = NOW()
      WHERE id = ? AND (sre_lead_approval_status IS NULL OR sre_lead_approval_status = '' OR LOWER(sre_lead_approval_status) = 'open')`,
    [status, remarks || null, id]
  );
  return done.affectedRows;
}

// POST /api/cbgm/my-approvals/submit  { items: [{ type: 'threshold' | 'onboarding' | 'tier2', id, decision: 'approve' | 'reject', remarks }] }
// Onboarding and Tier-2 Journey: remarks are required to reject
// All decisions are saved together: if any item is no longer waiting for me, nothing is saved.
router.post('/submit', async (req, res, next) => {
  try {
    const me = req.user.username;
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(422).json({ message: 'Nothing to submit' });

    const reviewer = await reviewerId(me);
    const waiting = { threshold: await thresholdApprovals(me), onboarding: [...(await onboardingApprovals(me)), ...(await reviewApprovals(me))], tier2: await tier2Approvals(me) };
    const seen = new Set();
    const decisions = [];
    for (const it of items) {
      const type = String(it && it.type);
      const id = Number(it && it.id);
      const status = DECISIONS[String((it && it.decision) || '').toLowerCase()];
      if (!waiting[type] || !status) return res.status(422).json({ message: 'Each item needs Approve or Reject' });
      const row = waiting[type] && waiting[type].find((r) => r.id === id);
      if (!row) {
        return res.status(409).json({ message: 'Some requests are no longer waiting for your approval. Refresh and try again.' });
      }
      if (seen.has(`${type}-${id}`)) continue;
      seen.add(`${type}-${id}`);
      const remarks = String((it && it.remarks) || '').trim();
      if ((type === 'onboarding' || type === 'tier2') && status === DECISIONS.reject && !remarks) {
        return res.status(422).json({ message: 'Rejected Remarks are required for every rejected request' });
      }
      if (remarks.length > 1000) return res.status(422).json({ message: 'Remarks: at most 1000 characters' });
      decisions.push({ type, id, status, remarks: type === 'onboarding' || type === 'tier2' ? remarks : '', stage: row.stage });
    }

    // Tier-2 Journey: an approved Health Check ID must not be in c2e_mtj_journey_app already (check before saving anything)
    const tier2Approved = decisions.filter((d) => d.type === 'tier2' && d.status === DECISIONS.approve).map((d) => waiting.tier2.find((r) => r.id === d.id));
    const gone = await tier2Requests.missingEditTargets(tier2Approved);
    if (gone.length) {
      return res.status(409).json({ message: `The Tier-2 Journey of these edit requests no longer exists: ${gone.map((g) => g.health_id).join(', ')}. Reject them instead.` });
    }
    const dupes = await tier2Requests.duplicatesOnApprove(tier2Approved);
    // Edit requests: what they change (worked out now, before an approval updates the journey) for the decision email
    const tier2Changes = await tier2Requests.changesFor(decisions.filter((d) => d.type === 'tier2').map((d) => waiting.tier2.find((r) => r.id === d.id)));
    if (dupes.length) {
      return res.status(409).json({
        message: `These Health Check IDs are already in Tier-2 Journey: ${dupes.map((d) => `${d.health_id} (App Code ${d.app_code})`).join(', ')}. Reject them instead.`,
      });
    }

    // CBGM Team approvals create the live alerts: check every name first, so nothing is half-saved
    const toCreate = decisions.filter((d) => d.type === 'onboarding' && d.stage === 'cbgm' && d.status === DECISIONS.approve).map((d) => d.id);
    const { alerts, problems } = await onboardAlerts.prepare(toCreate);
    if (problems.length) {
      return res.status(409).json({
        message: `Cannot create these alerts: ${problems.map((p) => `${p.uid} (${p.message})`).join('; ')}. Reject them or fix the data, then submit again.`,
      });
    }

    const created = [];
    const conn = await getConnection();
    try {
      await conn.beginTransaction();
      for (const d of decisions) {
        const done = await decide(conn, d.type, d.id, d.status, me, d.remarks, d.stage, reviewer);
        const alert = done && d.stage === 'cbgm' && d.status === DECISIONS.approve && alerts.find((a) => a.requestId === d.id);
        if (alert) {
          await onboardAlerts.insertAlert(conn, alert);
          created.push(alert.summary);
        }
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    // Email the requesters of the Update Threshold decisions (Cc support)
    const thresholdRows = decisions
      .filter((d) => d.type === 'threshold')
      .map((d) => ({ ...waiting.threshold.find((r) => r.id === d.id), status: d.status }));
    if (thresholdRows.length) cbgmMail.thresholdDecided({ rows: thresholdRows, approver: req.user });

    // Alerts onboarded: email the requesters and SRE Leads (Cc the approver)
    if (created.length) {
      const reqRows = waiting.onboarding.filter((r) => decisions.some((d) => d.id === r.id && d.stage === 'cbgm'));
      cbgmMail.onboardingCompleted({ alerts: created, requesters: [...new Set(reqRows.map((r) => r.request_by))], leads: [...new Set(reqRows.map((r) => r.sre_lead))], approver: req.user });
    }

    // SRE Lead approved onboarding requests: ask the CBGM Team to approve (link to My Approval)
    const reviewRows = waiting.onboarding.filter((r) => r.stage === 'sre' && decisions.some((d) => d.id === r.id && d.stage === 'sre' && d.status === DECISIONS.approve))
      .map((r) => ({ ...r, sre_lead_remarks: decisions.find((d) => d.id === r.id && d.stage === 'sre').remarks }));
    if (reviewRows.length) cbgmMail.onboardingReviewRequested({ rows: reviewRows, lead: req.user });

    // Tier-2 Journey: ONE email with every decision, to all their requesters (rejected ones with the remarks)
    const tier2Rows = decisions.filter((d) => d.type === 'tier2')
      .map((d) => ({ ...waiting.tier2.find((r) => r.id === d.id), status: d.status, remarks: d.remarks, changes: tier2Changes.get(d.id) || [] }));
    if (tier2Rows.length) cbgmMail.tier2Decided({ rows: tier2Rows, approver: req.user });

    const approved = decisions.filter((d) => d.status === DECISIONS.approve).length;
    res.json({ approved, rejected: decisions.length - approved, alertsCreated: created.length, alerts: created }); // alerts: shown in a popup
  } catch (err) {
    next(err);
  }
});

module.exports = router;
