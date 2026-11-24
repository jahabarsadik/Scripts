const express = require('express');
const { query, getConnection } = require('../../services/db');
const { canUseApp, appCodesFor, allowedAppCodes, NO_ACCESS } = require('../../services/cbgm/appAccess');
const cbgmMail = require('../../services/cbgm/cbgmMail');

// CBGM Alert Enable/Disable Requests
//   Cascading choices from alert_criteria: App Code (ALERT_CRITERIA_HOSTGROUP) -> Alert Level (alertLevel)
//   -> Alert Type (alertType) -> Criteria ID (ALERT_CRITERIA_UID), whose requiresnocupdate gives the current status.
//   A request is saved to cbgm_alert_request with update_status 'Queue'; the requester can list, edit and cancel
//   their own requests (Request Status page). Edits and cancellations are logged in cbgm_alert_request_audit_user_action.
const router = express.Router();

// cbgm_alert_request.update_status values
const STATUS = { queue: 'Queue', partial: 'Partial Completed', done: 'Done', cancel: 'Cancel' };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const GRACE = 5 * 60 * 1000; // allow for the minutes between picking a time and pressing Submit
const MAX_DAYS_AHEAD = 30;
const MAX_ENABLE_AFTER_DISABLE_HOURS = 72;

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

// "YYYY-MM-DD HH:mm[:ss]" (local time) -> Date, or null if not a valid date-time
function parseDateTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(str(s));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Check the dates of a request. Active alert -> disable request (disableDate now..+30 days,
 * enableDate after it, max +72 hours). Inactive alert -> enable request (enableDate now..+30 days).
 * Returns { errors, disable, enable }.
 */
function checkDates(isActive, disableDate, enableDate) {
  const errors = {};
  const now = Date.now();
  const latest = now + MAX_DAYS_AHEAD * DAY;
  const enable = parseDateTime(enableDate);
  const disable = isActive ? parseDateTime(disableDate) : null;

  if (isActive) {
    if (!disable) errors.disableDate = 'Choose the Alert Disable Date';
    else if (disable.getTime() < now - GRACE || disable.getTime() > latest) errors.disableDate = `Must be between now and ${MAX_DAYS_AHEAD} days from now`;
    if (!enable) errors.enableDate = 'Choose the Alert Enable Date';
    else if (disable && (enable <= disable || enable.getTime() > disable.getTime() + MAX_ENABLE_AFTER_DISABLE_HOURS * HOUR)) {
      errors.enableDate = `Must be after the Disable Date and within ${MAX_ENABLE_AFTER_DISABLE_HOURS} hours of it`;
    }
  } else if (!enable) errors.enableDate = 'Choose the Alert Enable Date';
  else if (enable.getTime() < now - GRACE || enable.getTime() > latest) errors.enableDate = `Must be between now and ${MAX_DAYS_AHEAD} days from now`;
  return { errors, disable, enable };
}

const distinct = (column, where, params) =>
  query(
    `SELECT DISTINCT ${column} AS v FROM alert_criteria
      WHERE ${where.concat(`${column} IS NOT NULL AND ${column} <> ''`).join(' AND ')}
      ORDER BY ${column}`,
    params
  ).then((rows) => rows.map((r) => r.v));

// GET /api/cbgm/alert-requests/app-codes -> ['APP1', ...]: administrators every App Code that has alerts
// (alert_criteria), so they can enable / disable alerts of any App Code; others their own (user.APPLICATION)
router.get('/app-codes', async (req, res, next) => {
  try {
    res.json(req.user && req.user.is_admin ? await distinct('ALERT_CRITERIA_HOSTGROUP', [], []) : await appCodesFor(req.user));
  } catch (err) {
    next(err);
  }
});

// The lists below are empty for an App Code the user may not use
router.use(['/alert-levels', '/alert-types', '/criteria'], (req, res, next) => (canUseApp(req.user, str(req.query.appCode)) ? next() : res.json([])));

// GET /api/cbgm/alert-requests/alert-levels?appCode=APP1 -> ['FATAL', ...]
router.get('/alert-levels', async (req, res, next) => {
  try {
    res.json(await distinct('alertLevel', ['ALERT_CRITERIA_HOSTGROUP = ?'], [str(req.query.appCode)]));
  } catch (err) {
    next(err);
  }
});

// GET /api/cbgm/alert-requests/alert-types?appCode=APP1&alertLevel=FATAL -> ['FAIL_RATE', ...]
router.get('/alert-types', async (req, res, next) => {
  try {
    res.json(
      await distinct('alertType', ['ALERT_CRITERIA_HOSTGROUP = ?', 'alertLevel = ?'], [str(req.query.appCode), str(req.query.alertLevel)])
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/cbgm/alert-requests/criteria?appCode=&alertLevel=&alertType= -> [{ id, uid, status: 0 | 1 }]
router.get('/criteria', async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT alertCriteriaId AS id, ALERT_CRITERIA_UID AS uid, requiresnocupdate + 0 AS status -- BIT(1) -> 0 / 1
         FROM alert_criteria
        WHERE ALERT_CRITERIA_HOSTGROUP = ? AND alertLevel = ? AND alertType = ?
        ORDER BY ALERT_CRITERIA_UID`,
      [str(req.query.appCode), str(req.query.alertLevel), str(req.query.alertType)]
    );
    res.json(rows.map((r) => ({ ...r, status: Number(r.status) })));
  } catch (err) {
    next(err);
  }
});

// POST /api/cbgm/alert-requests
//   { appCode, alertLevel, alertType, criteriaUid, disableDate?, enableDate }   dates: "YYYY-MM-DD HH:mm"
//   Active alert   -> DISABLE request: disableDate (now .. +30 days), enableDate (after disableDate, max +72 hours)
//   Inactive alert -> ENABLE request:  enableDate (now .. +30 days)
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const errors = {};
    ['appCode', 'alertLevel', 'alertType', 'criteriaUid'].forEach((k) => {
      if (!str(b[k])) errors[k] = 'Required';
    });
    if (Object.keys(errors).length) return res.status(422).json({ message: 'Please complete the form', errors });
    if (!canUseApp(req.user, b.appCode)) return res.status(403).json({ message: NO_ACCESS, errors: { appCode: NO_ACCESS } });

    const [criteria] = await query(
      `SELECT alertCriteriaId AS id, requiresnocupdate + 0 AS status FROM alert_criteria
        WHERE ALERT_CRITERIA_UID = ? AND ALERT_CRITERIA_HOSTGROUP = ? AND alertLevel = ? AND alertType = ?`,
      [str(b.criteriaUid), str(b.appCode), str(b.alertLevel), str(b.alertType)]
    );
    if (!criteria) {
      return res.status(422).json({ message: 'This Criteria ID does not match the selected App Code, Alert Level and Alert Type', errors: { criteriaUid: 'Not found' } });
    }
    const isActive = Number(criteria.status) === 1;

    const dates = checkDates(isActive, b.disableDate, b.enableDate);
    const { disable, enable } = dates;
    Object.assign(errors, dates.errors);
    if (Object.keys(errors).length) return res.status(422).json({ message: 'Please correct the dates', errors });

    const result = await query(
      `INSERT INTO cbgm_alert_request
         (alert_criteria_id, request_start_date, request_end_date, update_status, require_snoc_flag,
          client_remote_address, request_by, request_date, approved_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'PENDING')`,
      [
        criteria.id,
        isActive ? disable : enable,
        isActive ? enable : null,
        STATUS.queue,
        isActive ? 0 : 1, // requiresnocupdate value requested for the period
        str(req.ip).slice(0, 100),
        req.user.username,
      ]
    );
    // Email: requester + the App Code's SRE Leads, Cc support
    cbgmMail.alertRequestSubmitted({
      action: isActive ? 'disable' : 'enable',
      appCode: str(b.appCode),
      alertLevel: str(b.alertLevel),
      alertType: str(b.alertType),
      criteriaUid: str(b.criteriaUid),
      disableDate: str(b.disableDate),
      enableDate: str(b.enableDate),
      user: req.user,
    });
    res.status(201).json({ id: result.insertId, action: isActive ? 'disable' : 'enable' });
  } catch (err) {
    next(err);
  }
});

// ---- Request Status: requests for the user's App Codes (user.APPLICATION), from anyone ----

const fmt = (col) => `DATE_FORMAT(${col}, '%Y-%m-%d %H:%i')`;

/**
 * Requests with the alert's App Code / Level / Type / Criteria ID and who asked for them.
 *   { username, id }  -> that user's own request (used before Edit / Cancel)
 *   { appCodes }      -> every request for those App Codes (null = all)
 */
function findRequests({ username, id, appCodes }) {
  const where = [];
  const params = [];
  if (username) { where.push('r.request_by = ?'); params.push(username); }
  if (id) { where.push('r.alert_request_id = ?'); params.push(id); }
  if (appCodes) { where.push('ac.ALERT_CRITERIA_HOSTGROUP IN (?)'); params.push(appCodes); }
  return query(
    `SELECT r.alert_request_id AS id, r.update_status AS status, r.require_snoc_flag + 0 AS snoc_flag,
            ${fmt('r.request_start_date')} AS start_date, ${fmt('r.request_end_date')} AS end_date,
            ${fmt('r.request_date')} AS request_date, ${fmt('r.update_date')} AS update_date,
            r.approved_status, r.approved_by,
            ac.ALERT_CRITERIA_HOSTGROUP AS app_code, ac.alertLevel AS alert_level, ac.alertType AS alert_type,
            ac.ALERT_CRITERIA_UID AS criteria_uid,
            r.request_by, COALESCE(NULLIF(u.USERNAME, ''), r.request_by) AS requester_name
       FROM cbgm_alert_request r
       JOIN alert_criteria ac ON ac.alertCriteriaId = r.alert_criteria_id
       LEFT JOIN user u ON u.LOGINID = r.request_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.request_date DESC, r.alert_request_id DESC`,
    params
  ).then((rows) =>
    // require_snoc_flag 0 = disable request (start = Disable Date, end = Enable Date); 1 = enable request (start = Enable Date)
    rows.map((r) => ({ ...r, snoc_flag: Number(r.snoc_flag), action: Number(r.snoc_flag) === 0 ? 'disable' : 'enable' }))
  );
}

function audit(conn, requestId, type, oldValue, newValue, req) {
  return conn.query(
    `INSERT INTO cbgm_alert_request_audit_user_action
       (alert_request_id, request_type, require_snoc_flag, old_value, new_value, client_remote_address, request_by, request_date)
     SELECT alert_request_id, ?, require_snoc_flag, ?, ?, ?, ?, NOW() FROM cbgm_alert_request WHERE alert_request_id = ?`,
    [type, oldValue, newValue, str(req.ip).slice(0, 100), req.user.username, requestId]
  );
}

async function inTransaction(work) {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// GET /api/cbgm/alert-requests/mine -> requests for the user's App Codes, by anyone (all statuses; the page
// splits them into tabs). `mine` = raised by this user, so the page offers Edit / Cancel only on those.
router.get('/mine', async (req, res, next) => {
  try {
    const appCodes = allowedAppCodes(req.user); // null = administrator: every App Code
    if (appCodes && !appCodes.length) return res.json([]);
    const me = String(req.user.username).toLowerCase();
    const rows = await findRequests({ appCodes });
    res.json(rows.map((r) => ({ ...r, mine: String(r.request_by).toLowerCase() === me })));
  } catch (err) {
    next(err);
  }
});

const findQueued = async (req, res) => {
  const [r] = await findRequests({ username: req.user.username, id: req.params.id }); // own requests only
  if (!r) {
    res.status(404).json({ message: 'Request not found' });
    return null;
  }
  if (String(r.status).toLowerCase() !== STATUS.queue.toLowerCase()) {
    res.status(422).json({ message: `Only requests in ${STATUS.queue} can be changed (this one is ${r.status})` });
    return null;
  }
  return r;
};

// PUT /api/cbgm/alert-requests/:id  { disableDate?, enableDate }  (own requests in Queue only)
router.put('/:id(\\d+)', async (req, res, next) => {
  try {
    const r = await findQueued(req, res);
    if (!r) return;
    const b = req.body || {};
    const isDisable = r.action === 'disable';
    const { errors, disable, enable } = checkDates(isDisable, b.disableDate, b.enableDate);
    if (Object.keys(errors).length) return res.status(422).json({ message: 'Please correct the dates', errors });

    const newStart = isDisable ? disable : enable;
    const newEnd = isDisable ? enable : null;
    const oldStart = parseDateTime(r.start_date);
    const oldEnd = parseDateTime(r.end_date);
    await inTransaction(async (conn) => {
      await conn.query(
        `UPDATE cbgm_alert_request SET request_start_date = ?, request_end_date = ?, update_by = ?, update_date = NOW()
          WHERE alert_request_id = ? AND update_status = ?`,
        [newStart, newEnd, req.user.username, r.id, STATUS.queue]
      );
      if (String(oldStart) !== String(newStart)) await audit(conn, r.id, 'EDIT_START_DATE', oldStart, newStart, req);
      if (String(oldEnd) !== String(newEnd)) await audit(conn, r.id, 'EDIT_END_DATE', oldEnd, newEnd, req);
    });
    res.json({ message: 'Request updated' });
  } catch (err) {
    next(err);
  }
});

// POST /api/cbgm/alert-requests/:id/cancel  (own requests in Queue only) -> update_status 'Cancel'
router.post('/:id(\\d+)/cancel', async (req, res, next) => {
  try {
    const r = await findQueued(req, res);
    if (!r) return;
    await inTransaction(async (conn) => {
      await conn.query(
        `UPDATE cbgm_alert_request SET update_status = ?, update_by = ?, update_date = NOW()
          WHERE alert_request_id = ? AND update_status = ?`,
        [STATUS.cancel, req.user.username, r.id, STATUS.queue]
      );
      await audit(conn, r.id, 'CANCEL', null, null, req);
    });
    res.json({ message: 'Request cancelled' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
