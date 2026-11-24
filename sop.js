const express = require('express');
const { query, getConnection } = require('../../services/db');
const { canUseApp, appCodesFor, NO_ACCESS } = require('../../services/cbgm/appAccess');
const cbgmMail = require('../../services/cbgm/cbgmMail');

// CBGM Update SOP ID
//   App Codes: alert_criteria.ALERT_CRITERIA_HOSTGROUP (only the user's own App Codes: user.APPLICATION)
//   Rows: the App Code's alert_criteria; Service Name / Alert Type / Alert Level come from the matching
//   config_service_threshold row (criteria_id = ALERT_CRITERIA_UID) when there is one, else from alert_criteria.
//   Submit updates alert_criteria.SOP_ID (WHERE ALERT_CRITERIA_UID = ?) straight away, then emails the SRE Leads.
const router = express.Router();

const SOP_MAX = 255; // alert_criteria.SOP_ID is VARCHAR(255)
// Allowed SOP IDs end with _A_<digits>, _T_<digits>, _HC_<digits> or _B_<text without _> (same rule on the page, SopForm.jsx)
const SOP_PATTERN = /_((A|T|HC)_[0-9]+|B_[^_]+)$/;
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

function criteriaFor(appCode) {
  return query(
    `SELECT ac.alertCriteriaId AS id, ac.ALERT_CRITERIA_UID AS uid, ac.SOP_ID AS sop_id,
            COALESCE(NULLIF(t.service_name, ''), ac.ALERT_CRITERIA_DESC) AS service_name,
            COALESCE(NULLIF(t.alert_type, ''), ac.alertType) AS alert_type,
            COALESCE(NULLIF(t.alert_level, ''), ac.alertLevel) AS alert_level
       FROM alert_criteria ac
       LEFT JOIN (SELECT criteria_id, MIN(service_name) AS service_name, MIN(alert_type) AS alert_type, MIN(alert_level) AS alert_level
                    FROM config_service_threshold WHERE valid_id = 1 GROUP BY criteria_id) t
              ON t.criteria_id = ac.ALERT_CRITERIA_UID
      WHERE ac.ALERT_CRITERIA_HOSTGROUP = ?
      ORDER BY service_name, alert_type, alert_level, ac.ALERT_CRITERIA_UID`,
    [appCode]
  );
}

// GET /api/cbgm/sop/app-codes -> ['APP1', ...] (administrators: config_service_threshold; others: user.APPLICATION)
router.get('/app-codes', async (req, res, next) => {
  try {
    res.json(await appCodesFor(req.user));
  } catch (err) {
    next(err);
  }
});

// GET /api/cbgm/sop/criteria?appCode= -> [{ id, uid, service_name, alert_type, alert_level, sop_id }]
router.get('/criteria', async (req, res, next) => {
  try {
    const appCode = str(req.query.appCode);
    if (!canUseApp(req.user, appCode)) return res.json([]);
    res.json(await criteriaFor(appCode));
  } catch (err) {
    next(err);
  }
});

// POST /api/cbgm/sop  { appCode, changes: [{ uid, sopId }] }
//   -> UPDATE alert_criteria SET SOP_ID = ? WHERE ALERT_CRITERIA_UID = ? (one transaction), then email
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const appCode = str(b.appCode);
    if (!appCode) return res.status(422).json({ message: 'Select an App Code', errors: { appCode: 'Select an App Code' } });
    if (!canUseApp(req.user, appCode)) return res.status(403).json({ message: NO_ACCESS, errors: { appCode: NO_ACCESS } });
    if (!Array.isArray(b.changes) || !b.changes.length) {
      return res.status(422).json({ message: 'Turn on and change at least one SOP ID', errors: { changes: 'Nothing to update' } });
    }

    const current = new Map((await criteriaFor(appCode)).map((c) => [c.uid, c]));
    const rowErrors = {};
    const changes = [];
    const seen = new Set();
    for (const ch of b.changes) {
      const c = current.get(str(ch && ch.uid));
      if (!c) return res.status(422).json({ message: 'A Criteria ID does not belong to this App Code' });
      if (seen.has(c.uid)) continue;
      seen.add(c.uid);
      const sopId = str(ch.sopId);
      if (!sopId) rowErrors[c.uid] = 'SOP ID is required';
      else if (sopId.length > SOP_MAX) rowErrors[c.uid] = `SOP ID can be at most ${SOP_MAX} characters`;
      else if (/[\x00-\x1f\x7f]/.test(sopId)) rowErrors[c.uid] = 'SOP ID contains invalid characters';
      else if (!SOP_PATTERN.test(sopId)) rowErrors[c.uid] = 'SOP ID must end with _A_, _T_ or _HC_ + digits, or _B_ + text (e.g. SOP_A_123, SOP_HC_45, SOP_B_Payment)';
      else if (sopId !== str(c.sop_id)) changes.push({ c, sopId });
    }
    if (Object.keys(rowErrors).length) return res.status(422).json({ message: 'Please correct the highlighted SOP IDs', errors: { rows: rowErrors } });
    if (!changes.length) return res.status(422).json({ message: 'No SOP IDs were changed', errors: { changes: 'No SOP IDs were changed' } });

    const conn = await getConnection();
    try {
      await conn.beginTransaction();
      for (const { c, sopId } of changes) {
        await conn.query(
          'UPDATE alert_criteria SET SOP_ID = ?, LAST_UPDATED_DT = NOW() WHERE ALERT_CRITERIA_UID = ? AND ALERT_CRITERIA_HOSTGROUP = ?',
          [sopId, c.uid, appCode]
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    console.log(
      `SOP ID updated by ${req.user.username} for ${appCode}: ` +
        changes.map(({ c, sopId }) => `${c.uid} "${str(c.sop_id) || '-'}" -> "${sopId}"`).join('; ')
    );

    // Email: the App Code's SRE Leads, Cc requester + support
    cbgmMail.sopUpdated({ appCode, changes, user: req.user });
    res.json({ count: changes.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
