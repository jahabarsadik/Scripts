const express = require('express');
const { query, getConnection } = require('../../services/db');
const { canUseApp, appCodesFor, NO_ACCESS } = require('../../services/cbgm/appAccess');
const cbgmMail = require('../../services/cbgm/cbgmMail');

// CBGM Update Threshold
//   App Codes: config_service_threshold.app_code, limited to the user's own App Codes (user.APPLICATION)
//   Hours Type: config_service_threshold.peak_hours; SRE Lead: cbgm_sre_lead_apps.sre_lead_id for the App Code
//   A request adds one row per changed service to config_service_threshold_history with approval_status 'Open';
//   config_service_threshold itself changes only after the SRE Lead approves.
const router = express.Router();

const OPEN = 'Open';
const LIMITS = {
  low: { min: 1, max: 25, label: 'Consecutive Point' },
  failure: { min: 1, max: 100, label: 'Fail Rate %' },
  high: { min: 0, max: 99999999, label: 'Threshold Value' },
};
const HISTORY_SERVICE_MAX = 100; // config_service_threshold_history.service_name is VARCHAR(100)

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const sameValue = (a, b) => str(a) === str(b);

// SRE Leads for an App Code, with their name from `user` (USERNAME) or cbgm_portal_users when known.
// The requester is left out: nobody approves their own change.
function sreLeads(appCode, requester) {
  return query(
    `SELECT DISTINCT s.sre_lead_id AS id,
            COALESCE(NULLIF(u.USERNAME, ''), NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), ''), s.sre_lead_id) AS name
       FROM cbgm_sre_lead_apps s
       LEFT JOIN user u ON u.LOGINID = s.sre_lead_id
       LEFT JOIN cbgm_portal_users p ON p.\`1bank_id\` = s.sre_lead_id
      WHERE s.app_code = ? AND s.valid_id = 1 AND s.sre_lead_id <> ?
      ORDER BY name`,
    [appCode, str(requester)]
  );
}

// Thresholds for an App Code + Hours Type; `pending` = a request for it is still Open
function services(appCode, hoursType) {
  return query(
    `SELECT t.id, t.service_name, t.alert_type, t.alert_level, t.config_header,
            t.low_conservative_points AS low, t.failure_percent AS failure, t.high_conservative_point AS high,
            EXISTS (SELECT 1 FROM config_service_threshold_history h WHERE h.threshold_id = t.id AND h.approval_status = ?) AS pending
       FROM config_service_threshold t
      WHERE t.app_code = ? AND t.peak_hours = ? AND t.valid_id = 1
      ORDER BY t.service_name, t.alert_type, t.alert_level, t.id`,
    [OPEN, appCode, hoursType]
  ).then((rows) => rows.map((r) => ({ ...r, pending: !!r.pending })));
}

// Every route below that takes an App Code checks it against the user's Application list
router.use(['/hours-types', '/sre-leads', '/services'], (req, res, next) => (canUseApp(req.user, str(req.query.appCode)) ? next() : res.json([])));

// GET /api/cbgm/threshold/app-codes -> ['APP1', ...] (administrators: config_service_threshold; others: user.APPLICATION)
router.get('/app-codes', async (req, res, next) => {
  try {
    res.json(await appCodesFor(req.user));
  } catch (err) {
    next(err);
  }
});

// GET /api/cbgm/threshold/hours-types?appCode= -> ['Normal Hrs', 'Peak Hrs', ...]
router.get('/hours-types', async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT DISTINCT peak_hours FROM config_service_threshold
        WHERE app_code = ? AND valid_id = 1 AND peak_hours IS NOT NULL AND peak_hours <> '' ORDER BY peak_hours`,
      [str(req.query.appCode)]
    );
    res.json(rows.map((r) => r.peak_hours));
  } catch (err) {
    next(err);
  }
});

// GET /api/cbgm/threshold/sre-leads?appCode= -> [{ id, name }]
router.get('/sre-leads', async (req, res, next) => {
  try {
    res.json(await sreLeads(str(req.query.appCode), req.user.username));
  } catch (err) {
    next(err);
  }
});

// GET /api/cbgm/threshold/services?appCode=&hoursType= -> [{ id, service_name, alert_type, alert_level, low, failure, high, pending }]
router.get('/services', async (req, res, next) => {
  try {
    res.json(await services(str(req.query.appCode), str(req.query.hoursType)));
  } catch (err) {
    next(err);
  }
});

/** "12" -> 12, '' / null -> null, anything else -> NaN */
const toNumber = (v) => (str(v) === '' ? null : /^\d+(\.\d+)?$/.test(str(v)) ? Number(v) : NaN);

// POST /api/cbgm/threshold
//   { appCode, hoursType, sreLeadId, changes: [{ id, low, failure, high }] }
//   -> one config_service_threshold_history row per changed threshold, approval_status 'Open'
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const appCode = str(b.appCode);
    const hoursType = str(b.hoursType);
    const sreLeadId = str(b.sreLeadId);
    const errors = {};
    if (!appCode) errors.appCode = 'Select an App Code';
    if (!hoursType) errors.hoursType = 'Select a Hours Type';
    if (!sreLeadId) errors.sreLeadId = 'Select the SRE Lead';
    if (!Array.isArray(b.changes) || !b.changes.length) errors.changes = 'Turn on and change at least one service';
    if (Object.keys(errors).length) return res.status(422).json({ message: Object.values(errors)[0], errors });
    if (!canUseApp(req.user, appCode)) return res.status(403).json({ message: NO_ACCESS, errors: { appCode: NO_ACCESS } });

    const leads = await sreLeads(appCode, req.user.username);
    const lead = leads.find((l) => l.id === sreLeadId);
    if (!lead) {
      const message = sreLeadId === req.user.username ? 'You cannot choose yourself as the SRE Lead for your own request' : 'This SRE Lead is not assigned to the App Code';
      return res.status(422).json({ message, errors: { sreLeadId: message } });
    }

    const current = Object.fromEntries((await services(appCode, hoursType)).map((s) => [String(s.id), s]));
    const rowErrors = {};
    const changes = [];
    for (const c of b.changes) {
      const s = current[String(c && c.id)];
      if (!s) return res.status(422).json({ message: 'A service does not belong to this App Code and Hours Type' });
      if (s.pending) {
        rowErrors[s.id] = 'A change for this service is already waiting for approval';
        continue;
      }
      const updated = {};
      for (const key of ['low', 'failure', 'high']) {
        // Only values the service already has can be changed; an empty one stays empty
        const value = c[key] === undefined || str(s[key]) === '' ? s[key] : c[key];
        const n = toNumber(value);
        const { min, max, label } = LIMITS[key];
        if (n === null) {
          if (str(s[key]) !== '') rowErrors[s.id] = `${label} cannot be empty`;
          updated[key] = null;
        } else if (Number.isNaN(n) || n < min || n > max || (key !== 'high' && !Number.isInteger(n))) {
          rowErrors[s.id] = `${label} must be ${key === 'high' ? 'a number' : 'a whole number'} from ${min} to ${max}`;
        } else updated[key] = String(n);
      }
      if (rowErrors[s.id]) continue;
      if (['low', 'failure', 'high'].every((k) => sameValue(updated[k], s[k]))) continue; // nothing changed
      changes.push({ s, updated });
    }
    if (Object.keys(rowErrors).length) return res.status(422).json({ message: 'Please correct the highlighted services', errors: { rows: rowErrors } });
    if (!changes.length) return res.status(422).json({ message: 'No values were changed', errors: { changes: 'No values were changed' } });

    const conn = await getConnection();
    try {
      await conn.beginTransaction();
      for (const { s, updated } of changes) {
        await conn.query(
          `INSERT INTO config_service_threshold_history
             (threshold_id, app_code, config_header, service_name, peak_hours,
              old_low_conservative_points, new_low_conservative_points, old_failure_percent, new_failure_percent,
              old_high_conservative_point, new_high_conservative_point,
              approved_by, approval_status, client_ip, request_by, change_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [s.id, appCode, s.config_header, String(s.service_name || '').slice(0, HISTORY_SERVICE_MAX), hoursType,
            s.low, updated.low, s.failure, updated.failure, s.high, updated.high,
            sreLeadId, OPEN, str(req.ip).slice(0, 100), req.user.username]
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    // Email: the chosen SRE Lead, Cc requester + support
    cbgmMail.thresholdRequested({ appCode, hoursType, lead, changes, user: req.user });
    res.status(201).json({ count: changes.length, sreLead: lead });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
