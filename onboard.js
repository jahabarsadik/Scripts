const express = require('express');
const config = require('../../config/config');
const { query, getConnection } = require('../../services/db');
const { canUseApp, filterAppCodes, NO_ACCESS } = require('../../services/cbgm/appAccess');
const cbgmMail = require('../../services/cbgm/cbgmMail');
const { buildXlsx } = require('../../services/xlsx');
const alertReviewers = require('../../services/cbgm/alertReviewers');

// CBGM Onboard New Alerts (/CBGM/alerts/onboard)
//   CBGM Cluster -> App Code -> Index Name : cbgm_daily_index with a new service (is_new_service = 1); App Codes: the
//                                            user's own (user.APPLICATION); administrators: every one
//   SRE Lead                               : cbgm_sre_lead_apps for the App Code (requester left out)
//   Services: cbgm_daily_service_monitoring with is_new_service = 1 for that index, one row per alert type + level
//   that is NOT already in config_service_threshold (same app_code, service_name, alert_type, alert_level, valid) and
//   has no onboarding request still waiting or approved.
//   Submit adds one alert_onboard_request row per service / alert type / alert level (approved in My Approval):
//   service_id, alert_type, alert_level, consecutive_points, operator, threshold, snoc_flag (0/1), remarks, sre_lead_id.
//   Email: To SRE Lead, Cc requester.
//   Batches: the page gets the first config.onboardServicesPerBatch services (default 50); once they are requested they
//   drop out of the list, so the next ones come up, until none are left.
const router = express.Router();

const ALERT_TYPES = ['THROUGHPUT', 'FAIL_RATE', 'RESPONSE_TIME'];
const ALERT_LEVELS = ['FATAL', 'WARNING'];
const OPERATORS = { THROUGHPUT: ['<=', '>='], FAIL_RATE: ['>='], RESPONSE_TIME: ['>='] };
const LIMITS = {
  consecutive: { min: 1, max: 25 },
  failRate: { min: 1, max: 100 }, // FAIL_RATE: percent
  threshold: { min: 0, max: 99999999 }, // THROUGHPUT (alert_onboard_request.threshold is INT)
  responseTime: { min: 1, max: 99999999 }, // RESPONSE_TIME: not 0
};
const REMARKS_MAX = 1000;

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const key = (...parts) => parts.map((p) => str(p).toLowerCase()).join('|');

// App Code access (services/cbgm/appAccess.js). The App Codes come from cbgm_daily_index (the chosen cluster):
// non-admins only those matching their user.APPLICATION, administrators all of them (also new App Codes that are not
// in config_service_threshold yet).
// ?newOnly=1 (Onboard New Alerts): only clusters / App Codes / indexes that have a new service (is_new_service = 1).
const appAllowed = (req, appCode) => canUseApp(req.user, appCode);
const appFilter = async (req, appCodes) => filterAppCodes(req.user, appCodes); // administrators: unchanged
const NEW_ONLY = `AND EXISTS (SELECT 1 FROM cbgm_daily_service_monitoring sm WHERE sm.index_id = di.id AND sm.is_new_service = 1)`;
const newOnly = (req) => (str(req.query.newOnly) === '1' ? NEW_ONLY : '');

// GET /clusters[?scope=all] -> ['CBGM', ...] (clusters that have at least one of the user's App Codes)
router.get('/clusters', async (req, res, next) => {
  try {
    const rows = await query(`SELECT DISTINCT di.cbgm_cluster, di.app_code FROM cbgm_daily_index di WHERE di.cbgm_cluster <> '' ${newOnly(req)} ORDER BY di.cbgm_cluster`);
    const allowed = new Set(await appFilter(req, [...new Set(rows.map((r) => r.app_code))]));
    res.json([...new Set(rows.filter((r) => allowed.has(r.app_code)).map((r) => r.cbgm_cluster))]);
  } catch (err) {
    next(err);
  }
});

// GET /app-codes?cluster=[&scope=all] -> ['APP1', ...]
router.get('/app-codes', async (req, res, next) => {
  try {
    const rows = await query(`SELECT DISTINCT di.app_code FROM cbgm_daily_index di WHERE di.cbgm_cluster = ? ${newOnly(req)} ORDER BY di.app_code`, [str(req.query.cluster)]);
    res.json(await appFilter(req, rows.map((r) => r.app_code)));
  } catch (err) {
    next(err);
  }
});

// GET /index-names?cluster=&appCode= -> ['logs-…', ...]
router.get('/index-names', async (req, res, next) => {
  try {
    const appCode = str(req.query.appCode);
    if (!appAllowed(req, appCode)) return res.json([]);
    const rows = await query(
      `SELECT DISTINCT di.index_name FROM cbgm_daily_index di WHERE di.cbgm_cluster = ? AND di.app_code = ? ${newOnly(req)} ORDER BY di.index_name`,
      [str(req.query.cluster), appCode]
    );
    res.json(rows.map((r) => r.index_name));
  } catch (err) {
    next(err);
  }
});

// SRE Leads for an App Code: value = cbgm_sre_lead_apps.id (alert_onboard_request.sre_lead_id), label = "Name (1bank ID)"
function sreLeads(appCode, requester) {
  return query(
    `SELECT MIN(s.id) AS value, s.sre_lead_id AS lead_id,
            COALESCE(NULLIF(MAX(u.USERNAME), ''), NULLIF(TRIM(CONCAT_WS(' ', MAX(p.first_name), MAX(p.last_name))), ''), s.sre_lead_id) AS name
       FROM cbgm_sre_lead_apps s
       LEFT JOIN user u ON u.LOGINID = s.sre_lead_id
       LEFT JOIN cbgm_portal_users p ON p.\`1bank_id\` = s.sre_lead_id
      WHERE s.app_code = ? AND s.valid_id = 1 AND LOWER(s.sre_lead_id) <> LOWER(?)
      GROUP BY s.sre_lead_id
      ORDER BY name`,
    [appCode, str(requester)]
  );
}

// GET /sre-leads?appCode= -> [{ value, label }]
router.get('/sre-leads', async (req, res, next) => {
  try {
    const appCode = str(req.query.appCode);
    if (!appAllowed(req, appCode)) return res.json([]);
    const rows = await sreLeads(appCode, req.user.username);
    res.json(rows.map((r) => ({ value: String(r.value), label: r.name !== r.lead_id ? `${r.name} (${r.lead_id})` : r.lead_id })));
  } catch (err) {
    next(err);
  }
});

/**
 * New services for the index and the alert type / level pairs they still need:
 * [{ service_id, service_name, alert_type, levels: ['FATAL', 'WARNING'] }] (one entry per service + alert type)
 */
async function missingAlerts(cluster, appCode, indexName) {
  const services = await query(
    `SELECT sm.id, sm.service_name FROM cbgm_daily_service_monitoring sm
      WHERE sm.is_new_service = 1
        AND sm.index_id IN (SELECT id FROM cbgm_daily_index WHERE index_name = ? AND app_code = ? AND cbgm_cluster = ?)
      ORDER BY sm.service_name, sm.id`,
    [indexName, appCode, cluster]
  );
  if (!services.length) return [];
  const configured = await query(
    `SELECT service_name, alert_type, alert_level FROM config_service_threshold
      WHERE app_code = ? AND valid_id = 1 AND service_name IN (?)`,
    [appCode, [...new Set(services.map((s) => s.service_name))]]
  );
  // A request that is still waiting (or already approved) also counts: no duplicate requests
  const requested = await query(
    `SELECT service_id, alert_type, alert_level FROM alert_onboard_request
      WHERE service_id IN (?) AND (sre_lead_approval_status IS NULL OR sre_lead_approval_status = ''
            OR LOWER(sre_lead_approval_status) IN ('open', 'approved'))
        AND (cbgm_approval_status IS NULL OR cbgm_approval_status = '' OR LOWER(cbgm_approval_status) <> 'rejected')`,
    [services.map((s) => s.id)]
  );
  const skip = new Set([
    ...configured.map((c) => key('name', c.service_name, c.alert_type, c.alert_level)),
    ...requested.map((r) => key('id', r.service_id, r.alert_type, r.alert_level)),
  ]);
  const out = [];
  for (const s of services) {
    for (const alertType of ALERT_TYPES) {
      const levels = ALERT_LEVELS.filter(
        (level) => !skip.has(key('name', s.service_name, alertType, level)) && !skip.has(key('id', s.id, alertType, level))
      );
      if (levels.length) out.push({ service_id: s.id, service_name: s.service_name, alert_type: alertType, levels });
    }
  }
  return out;
}

// Services per batch on the page (config.onboardServicesPerBatch, whole number from 1; default 50)
const perBatch = () => {
  const n = Number(config.onboardServicesPerBatch);
  return Number.isInteger(n) && n > 0 ? n : 50;
};

// GET /services?cluster=&appCode=&indexName=
//   -> { alerts: [the missingAlerts entries of the first <batch> services], batch, totalServices }
router.get('/services', async (req, res, next) => {
  try {
    const appCode = str(req.query.appCode);
    if (!appAllowed(req, appCode)) return res.status(403).json({ message: NO_ACCESS });
    const all = await missingAlerts(str(req.query.cluster), appCode, str(req.query.indexName));
    const ids = [...new Set(all.map((a) => a.service_id))]; // in service name order
    const batch = perBatch();
    const shown = new Set(ids.slice(0, batch));
    res.json({ alerts: all.filter((a) => shown.has(a.service_id)), batch, totalServices: ids.length });
  } catch (err) {
    next(err);
  }
});

/*
 * View Alert Onboarded Status (/CBGM/alerts/view, Alert Management menu): every service of the index
 * (cbgm_daily_service_monitoring, is_new_service 1 or 0 - CBGM approval sets 0) with its identify_date and where it stands:
 *   Pending SRE Lead Review  - a request waits for the SRE Lead (sre_lead_approval_status Open / empty)
 *   Pending CBGM Team Review - the SRE Lead approved, the CBGM Team has not decided yet
 *   Onboarded          - all six alerts are live (Response Time / Throughput / Fail Rate x FATAL / WARNING all ticked)
 *   Partial Onboarded  - nothing pending; some of the six alerts are live, not all (e.g. only Response Time FATAL)
 *   Not Onboarded      - nothing pending and none of the six alerts is live (all crosses)
 * One row per service; `alerts` says which of Response Time / Throughput / Fail Rate x FATAL / WARNING are live
 * (in config_service_threshold, or approved by both the SRE Lead and the CBGM Team). Read only.
 * Administrators see every App Code (scope=all); other users only their own (user.APPLICATION).
 */
const ONBOARD_STATUSES = ['Not Onboarded', 'Partial Onboarded', 'Pending SRE Lead Review', 'Pending CBGM Team Review', 'Onboarded'];
const STATUS_ALERT_TYPES = [['RESPONSE_TIME', 'Response Time'], ['THROUGHPUT', 'Throughput'], ['FAIL_RATE', 'Fail Rate']];
const UNDECIDED = (v) => !v || String(v).trim() === '' || String(v).trim().toLowerCase() === 'open';
const isStatus = (v, s) => String(v || '').trim().toLowerCase() === s;

async function onboardingStatus(cluster, appCode, indexName) {
  const services = await query(
    `SELECT sm.id, sm.service_name, DATE_FORMAT(sm.identify_date, '%Y-%m-%d') AS identify_date, sm.is_new_service
       FROM cbgm_daily_service_monitoring sm
      WHERE sm.index_id IN (SELECT id FROM cbgm_daily_index WHERE index_name = ? AND app_code = ? AND cbgm_cluster = ?)
      ORDER BY sm.service_name, sm.id`,
    [indexName, appCode, cluster]
  );
  if (!services.length) return [];
  const requests = await query(
    `SELECT r.service_id, r.alert_type, r.alert_level, r.sre_lead_approval_status AS sre_status, r.cbgm_approval_status AS cbgm_status,
            s.sre_lead_id AS sre_lead,
            COALESCE(NULLIF(MAX(lu.USERNAME), ''), NULLIF(TRIM(CONCAT_WS(' ', MAX(lp.first_name), MAX(lp.last_name))), ''), s.sre_lead_id) AS sre_lead_name,
            COALESCE(NULLIF(TRIM(CONCAT_WS(' ', pu.first_name, pu.last_name)), ''), pu.\`1bank_id\`) AS requester_name,
            DATE_FORMAT(r.requested_time, '%Y-%m-%d %H:%i') AS requested_time
       FROM alert_onboard_request r
       LEFT JOIN cbgm_sre_lead_apps s ON s.id = r.sre_lead_id
       LEFT JOIN user lu ON lu.LOGINID = s.sre_lead_id
       LEFT JOIN cbgm_portal_users lp ON lp.\`1bank_id\` = s.sre_lead_id
       LEFT JOIN cbgm_portal_users pu ON pu.id = r.requested_by
      WHERE r.service_id IN (?)
      GROUP BY r.id
      ORDER BY r.requested_time DESC, r.id DESC`,
    [services.map((x) => x.id)]
  );
  const configured = await query(
    `SELECT service_name, alert_type, alert_level FROM config_service_threshold
      WHERE app_code = ? AND valid_id = 1 AND service_name IN (?)`,
    [appCode, [...new Set(services.map((x) => x.service_name))]]
  );
  const live = new Set([
    ...configured.map((c) => key('name', c.service_name, c.alert_type, c.alert_level)),
    ...requests.filter((r) => isStatus(r.sre_status, 'approved') && isStatus(r.cbgm_status, 'approved'))
      .map((r) => key('id', r.service_id, r.alert_type, r.alert_level)),
  ]);
  // Pending CBGM Team Review: the reviewers by full name (config.js CBGMAlertReviewer, names from cbgm_portal_users)
  const reviewerNames = (await alertReviewers.list()).map(alertReviewers.label).join(', ');
  const bySvc = new Map();
  requests.forEach((r) => bySvc.set(r.service_id, [...(bySvc.get(r.service_id) || []), r]));

  return services.map((svc) => {
    const reqs = bySvc.get(svc.id) || []; // newest first
    const waitSre = reqs.find((r) => UNDECIDED(r.sre_status));
    const waitCbgm = reqs.find((r) => isStatus(r.sre_status, 'approved') && UNDECIDED(r.cbgm_status));
    // { RESPONSE_TIME: { FATAL: true, WARNING: false }, ... }
    const alerts = Object.fromEntries(STATUS_ALERT_TYPES.map(([type]) => [type, Object.fromEntries(['FATAL', 'WARNING'].map((level) => [
      level, live.has(key('name', svc.service_name, type, level)) || live.has(key('id', svc.id, type, level)),
    ]))]));
    const allLive = STATUS_ALERT_TYPES.every(([type]) => alerts[type].FATAL && alerts[type].WARNING);
    const anyLive = STATUS_ALERT_TYPES.some(([type]) => alerts[type].FATAL || alerts[type].WARNING);
    let status;
    let pendingWith = '';
    let latest = reqs[0];
    if (waitSre) {
      status = 'Pending SRE Lead Review';
      latest = waitSre;
      pendingWith = waitSre.sre_lead_name && waitSre.sre_lead_name !== waitSre.sre_lead ? `${waitSre.sre_lead_name} (${waitSre.sre_lead})` : waitSre.sre_lead || '';
    } else if (waitCbgm) {
      status = 'Pending CBGM Team Review';
      latest = waitCbgm;
      pendingWith = reviewerNames ? `CBGM Team: ${reviewerNames}` : 'CBGM Team';
    } else if (allLive) status = 'Onboarded';
    else if (anyLive) status = 'Partial Onboarded';
    else status = 'Not Onboarded';
    return {
      service_id: svc.id,
      is_new_service: Number(svc.is_new_service) === 1 ? 1 : 0,
      service_name: svc.service_name,
      identify_date: svc.identify_date,
      status,
      pending_with: pendingWith,
      requested_by: latest ? latest.requester_name || '' : '',
      requested_time: latest ? latest.requested_time || '' : '',
      alerts,
    };
  });
}

// GET /status?cluster=&appCode=&indexName=[&statuses=Onboarded,Partial Onboarded,Not Onboarded] -> [{ service_id, service_name,
//   identify_date, status, pending_with, requested_by, requested_time, alerts }]  (statuses empty: all)
//   (admins: any App Code with scope=all; others: their own App Codes)
// GET /status/download?...same...      -> the same rows as an Excel file
async function statusRows(req, res) {
  const appCode = str(req.query.appCode);
  if (!appAllowed(req, appCode)) { res.status(403).json({ message: NO_ACCESS }); return null; }
  const known = ONBOARD_STATUSES.map((x) => x.toLowerCase());
  const wanted = str(req.query.statuses).split(',').map((x) => x.trim().toLowerCase()).filter((x) => known.includes(x));
  const rows = await onboardingStatus(str(req.query.cluster), appCode, str(req.query.indexName));
  return wanted.length ? rows.filter((r) => wanted.includes(r.status.toLowerCase())) : rows;
}

router.get('/status', async (req, res, next) => {
  try {
    const rows = await statusRows(req, res);
    if (rows) res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /status/:serviceId/new  { cluster, appCode, indexName }  (CBGM admins only)
//   A Not Onboarded / Partial Onboarded service (nothing pending) that lacks an alert (a cross among Response Time / Throughput / Fail Rate x FATAL /
//   WARNING) is marked new again: cbgm_daily_service_monitoring.is_new_service = 1, so Onboard New Alerts offers the
//   missing alerts. Checked again here: admin, App Code access, the service belongs to the index, Onboarded, a cross.
router.post('/status/:serviceId/new', async (req, res, next) => {
  try {
    if (!(req.user && req.user.is_admin)) return res.status(403).json({ message: 'Only CBGM admins can mark a service as new' });
    const id = Number(req.params.serviceId);
    const b = req.body || {};
    const cluster = str(b.cluster);
    const appCode = str(b.appCode);
    const indexName = str(b.indexName);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ message: 'Service not found' });
    if (!appAllowed(req, appCode)) return res.status(403).json({ message: NO_ACCESS });
    const row = (await onboardingStatus(cluster, appCode, indexName)).find((r) => r.service_id === id);
    if (!row) return res.status(404).json({ message: 'Service not found in this index' });
    const missing = STATUS_ALERT_TYPES.some(([type]) => ['FATAL', 'WARNING'].some((level) => !row.alerts[type][level]));
    if (row.is_new_service !== 0 || !['Not Onboarded', 'Partial Onboarded'].includes(row.status) || !missing) {
      return res.status(422).json({ message: 'Only a Not Onboarded or Partial Onboarded service with is_new_service = 0 and a missing alert (a cross) can be marked as new' });
    }
    const done = await query('UPDATE cbgm_daily_service_monitoring SET is_new_service = 1, update_time = NOW() WHERE id = ?', [id]);
    if (!done.affectedRows) return res.status(404).json({ message: 'Service not found' });
    console.log(`Onboarding: service ${id} (${row.service_name}, ${appCode} / ${indexName}) marked as new (is_new_service = 1) by ${req.user.username}`);
    res.json({ id, is_new_service: 1 });
  } catch (err) {
    next(err);
  }
});

const STATUS_COLUMNS = [
  { header: 'CBGM Cluster', key: 'cluster', width: 14 },
  { header: 'App Code', key: 'app_code', width: 14 },
  { header: 'Index Name', key: 'index_name', width: 34 },
  { header: 'Service Name', key: 'service_name', width: 50 },
  { header: 'Identify Date', key: 'identify_date', width: 14 },
  { header: 'Status', key: 'status', width: 20 },
  { header: 'Pending With', key: 'pending_with', width: 30 },
  { header: 'Requested By', key: 'requested_by', width: 24 },
  { header: 'Requested Time', key: 'requested_time', width: 18 },
  // one Yes / No column per alert type + level
  ...STATUS_ALERT_TYPES.flatMap(([type, label]) => ['FATAL', 'WARNING'].map((level) => ({ header: `${label} ${level}`, key: `${type}_${level}`, width: 16 }))),
];

router.get('/status/download', async (req, res, next) => {
  try {
    const rows = await statusRows(req, res);
    if (!rows) return;
    const where = { cluster: str(req.query.cluster), app_code: str(req.query.appCode), index_name: str(req.query.indexName) };
    const yesNo = (r) => Object.fromEntries(STATUS_ALERT_TYPES.flatMap(([type]) => ['FATAL', 'WARNING'].map((level) => [`${type}_${level}`, r.alerts[type][level] ? 'Yes' : 'No'])));
    const file = buildXlsx([{ name: 'Onboarding Status', columns: STATUS_COLUMNS, rows: rows.map((r) => ({ ...where, ...r, ...yesNo(r) })) }]);
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const filename = `Onboarding_Status_${where.app_code.replace(/[^\w-]/g, '_')}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': file.length,
    });
    res.send(file);
  } catch (err) {
    next(err);
  }
});

// Whole non-negative number within [min, max]; returns the number or an error message
function wholeNumber(v, { min, max }, label) {
  const s = str(v);
  if (!s) return { error: `${label} is required` };
  if (!/^\d+$/.test(s)) return { error: `${label}: whole numbers only (no negative values)` };
  const n = Number(s);
  if (n < min || n > max) return { error: `${label}: ${min} to ${max}` };
  return { value: n };
}

// POST /  { cluster, appCode, indexName, sreLeadId, rows: [{ service_id, alert_type, alert_level, configure, hour_type,
//          consecutive_points, operator, threshold, snoc, remarks, reason }] }
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const cluster = str(b.cluster);
    const appCode = str(b.appCode);
    const indexName = str(b.indexName);
    const sreLeadId = str(b.sreLeadId);
    const errors = {};
    if (!cluster) errors.cluster = 'Select a CBGM Cluster';
    if (!appCode) errors.appCode = 'Select an App Code';
    else if (!(req.user && req.user.is_admin) && !canUseApp(req.user, appCode)) errors.appCode = NO_ACCESS; // admins: any App Code
    if (!indexName) errors.indexName = 'Select an Index Name';
    if (!sreLeadId) errors.sreLeadId = 'Select an SRE Lead';
    if (Object.keys(errors).length) return res.status(422).json({ message: 'Please correct the highlighted fields', errors });

    // The requester cannot be the SRE Lead (sreLeads leaves them out); say so clearly
    const own = await query('SELECT sre_lead_id FROM cbgm_sre_lead_apps WHERE id = ?', [sreLeadId]);
    if (own.length && String(own[0].sre_lead_id).toLowerCase() === String(req.user.username).toLowerCase()) {
      return res.status(422).json({ message: 'You cannot be the SRE Lead for your own request', errors: { sreLeadId: 'You cannot be the SRE Lead for your own request' } });
    }
    const lead = (await sreLeads(appCode, req.user.username)).find((l) => String(l.value) === sreLeadId);
    if (!lead) return res.status(422).json({ message: 'Choose an SRE Lead from the list', errors: { sreLeadId: 'Choose an SRE Lead from the list' } });

    const me = await query('SELECT id FROM cbgm_portal_users WHERE `1bank_id` = ? AND valid_id = 1', [req.user.username]);
    if (!me.length) return res.status(403).json({ message: 'Your 1bank ID is not in cbgm_portal_users. Log out and in again, or contact CBGM Support Team.' });

    // Only alerts that are still missing can be requested
    const open = new Map();
    for (const m of await missingAlerts(cluster, appCode, indexName)) {
      for (const level of m.levels) open.set(key(m.service_id, m.alert_type, level), m.service_name);
    }
    const rowsIn = Array.isArray(b.rows) ? b.rows : [];
    if (!rowsIn.length) return res.status(422).json({ message: 'There are no alerts to request' });

    const rowErrors = {}; // keys like the page: '<service_id>|<alert_type>|<alert_level>|<field>' ('…|<alert_type>|reason')
    const rows = [];
    const seen = new Set();
    rowsIn.forEach((r) => {
      const e = {};
      const k = key(r.service_id, r.alert_type, r.alert_level);
      const serviceName = open.get(k);
      if (!serviceName) e.row = 'This alert is already configured or requested';
      else if (seen.has(k)) e.row = 'Listed twice';
      seen.add(k);
      const configure = r.configure !== false;
      const hourType = 'Normal Hrs'; // always Normal Hrs
      const remarks = ''; // remarks only come from the side panel when Configure Threshold is off
      const reason = str(r.reason);
      const row = { service_id: Number(r.service_id), service_name: serviceName, alert_type: str(r.alert_type), alert_level: str(r.alert_level), configure, hour_type: hourType, remarks };
      if (configure) {
        const cp = wholeNumber(r.consecutive_points, LIMITS.consecutive, 'Consecutive Point');
        const limit = row.alert_type === 'FAIL_RATE' ? LIMITS.failRate : row.alert_type === 'RESPONSE_TIME' ? LIMITS.responseTime : LIMITS.threshold;
        const th = wholeNumber(r.threshold, limit, row.alert_type === 'FAIL_RATE' ? 'Fail Rate' : row.alert_type === 'RESPONSE_TIME' ? 'Response Time threshold' : 'Threshold');
        if (cp.error) e.consecutive_points = cp.error;
        if (th.error) e.threshold = th.error;
        const ops = OPERATORS[row.alert_type] || ['>='];
        const op = str(r.operator) || ops[0];
        if (!ops.includes(op)) e.operator = `Choose ${ops.join(' or ')}`;
        Object.assign(row, { consecutive_points: cp.value, threshold: th.value, operator: op, snoc: r.snoc === true });
      } else {
        // Not configured: the reason is required and saved in remarks as typed
        if (!reason) e.reason = 'Remarks are required when Configure Threshold is off';
        else if (reason.length > REMARKS_MAX) e.reason = `At most ${REMARKS_MAX} characters`;
        row.remarks = reason; // saved as typed (no prefix)
      }
      const base = `${r.service_id}|${str(r.alert_type)}`;
      Object.entries(e).forEach(([f, msg]) => {
        rowErrors[f === 'reason' ? `${base}|reason` : `${base}|${str(r.alert_level)}|${f === 'row' ? 'consecutive_points' : f}`] = msg;
      });
      rows.push(row);
    });
    // FATAL and WARNING of the same service + alert type cannot have BOTH the same Consecutive Point and Threshold / Fail Rate
    const byGroup = new Map();
    rows.filter((r) => r.configure).forEach((r) => {
      const g = `${r.service_id}|${r.alert_type}`;
      byGroup.set(g, { ...(byGroup.get(g) || {}), [r.alert_level]: r });
    });
    byGroup.forEach((lv, g) => {
      if (!lv.FATAL || !lv.WARNING) return;
      const same = (f) => lv.FATAL[f] !== undefined && lv.FATAL[f] === lv.WARNING[f];
      if (!same('consecutive_points') || !same('threshold')) return;
      ['consecutive_points', 'threshold'].forEach((f) => {
        const k = `${g}|WARNING|${f}`;
        if (!rowErrors[k]) rowErrors[k] = 'WARNING has the same Consecutive Point and Threshold / Fail Rate as FATAL: change one';
      });
    });
    if (Object.keys(rowErrors).length) {
      const first = Object.values(rowErrors)[0];
      return res.status(422).json({ message: `Please correct the highlighted rows (${first})`, errors: rowErrors });
    }

    const conn = await getConnection();
    try {
      await conn.beginTransaction();
      for (const r of rows) {
        await conn.query(
          `INSERT INTO alert_onboard_request
             (service_id, alert_type, alert_level, consecutive_points, operator, threshold, snoc_flag, remarks,
              sre_lead_id, sre_lead_approval_status, requested_by, requested_client_ip, requested_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open', ?, ?, NOW())`,
          [r.service_id, r.alert_type, r.alert_level, r.configure ? r.consecutive_points : 0, r.configure ? r.operator : null, r.configure ? r.threshold : null,
            r.configure ? (r.snoc ? 1 : 0) : 0, r.remarks || null, Number(sreLeadId), me[0].id, str(req.ip).slice(0, 50)]
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
    cbgmMail.onboardingRequested({ cluster, appCode, indexName, lead: { id: lead.lead_id, name: lead.name }, rows, user: req.user });
    res.status(201).json({ count: rows.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
