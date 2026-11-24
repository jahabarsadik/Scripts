const express = require('express');
const { query } = require('../../services/db');
const rules = require('../../services/cbgm/blackoutRules');
const { canUseApp, appCodesFor, NO_ACCESS } = require('../../services/cbgm/appAccess');
const cbgmMail = require('../../services/cbgm/cbgmMail');

// CBGM Application Blackout + Maintenance Window
//   App Codes: alert_criteria.ALERT_CRITERIA_HOSTGROUP
//   Category / country: pm_app_codes.app_category, app_used_countries (rules in services/cbgm/blackoutRules.js)
//   Windows are saved in maintenance_window; all times are SGT.
const router = express.Router();

const SYSTEM_RECORD_INFO = 'UPDATE BY SYSTEM';
const MAX_REASON = 2000;
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const toDb = (sgt) => `${rules.formatSgt(rules.parseSgt(sgt))}:00`; // "YYYY-MM-DD HH:mm:00"

/** Category, country and rule text for an App Code; category is null when pm_app_codes has no usable row */
async function appInfo(appCode) {
  const [app] = await query('SELECT app_category, app_used_countries FROM pm_app_codes WHERE app_code = ? ORDER BY valid_id DESC, id DESC LIMIT 1', [appCode]);
  const countries = await query('SELECT id, country_code, country_name FROM pm_countries');
  const idToName = Object.fromEntries(countries.map((c) => [String(c.id), c.country_name || c.country_code]));
  const category = rules.categoryOf(app && app.app_category);
  const country = rules.resolveCountry(app && app.app_used_countries, idToName);
  return {
    appCode,
    found: !!app,
    category,
    country: { name: country.name, offset: country.offset },
    usedCountries: app ? app.app_used_countries : null,
    message: category ? rules.describeRule(appCode, category, country) : null,
  };
}

const countryFor = (info) => rules.COUNTRIES.find((c) => c.name === info.country.name) || rules.SINGAPORE;

// The logged-in user's active windows that have not ended, as SGT strings
async function myWindows(username) {
  return query(
    `SELECT MaintenanceWindowId AS id, APPLICATION_ID AS app_code,
            DATE_FORMAT(MAINTENANCE_START_DT, '%Y-%m-%d %H:%i') AS start_date,
            DATE_FORMAT(MAINTENANCE_END_DT, '%Y-%m-%d %H:%i') AS end_date,
            CHANGE_DESCRIPTION AS reason, INCIDENT_OR_CHANGE_RECORD_INFO AS record_info,
            REQUESTER_NAME AS requester_name, CREATER_NAME AS created_by,
            DATE_FORMAT(CREATED_DT, '%Y-%m-%d %H:%i') AS created_at
       FROM maintenance_window
      WHERE CREATER_NAME = ? AND isActive = 1 AND MAINTENANCE_END_DT > ?
      ORDER BY MAINTENANCE_START_DT`,
    [username, toDb(rules.formatSgt(rules.nowSgt()))]
  );
}

const phaseOf = (w, now = rules.nowSgt()) => (rules.parseSgt(w.start_date) <= now ? 'ongoing' : 'upcoming');

// GET /api/cbgm/blackout/app-codes -> ['APP1', ...] (administrators: config_service_threshold; others: user.APPLICATION)
router.get('/app-codes', async (req, res, next) => {
  try {
    res.json(await appCodesFor(req.user));
  } catch (err) {
    next(err);
  }
});

// GET /api/cbgm/blackout/app-info?appCode=APP1 -> { category, country: { name, offset }, message: [line1, line2] }
router.get('/app-info', async (req, res, next) => {
  try {
    const appCode = str(req.query.appCode);
    if (!appCode) return res.status(422).json({ message: 'App Code is required' });
    // 200 with noAccess (not 403), so the page can show the reason instead of the error page
    if (!canUseApp(req.user, appCode)) return res.json({ appCode, noAccess: true, category: null, message: null });
    res.json(await appInfo(appCode));
  } catch (err) {
    next(err);
  }
});

// POST /api/cbgm/blackout  { appCode, startDate, endDate, reason }  (dates "YYYY-MM-DD HH:mm" SGT)
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const appCode = str(b.appCode);
    const reason = str(b.reason);
    const errors = {};
    if (!appCode) errors.appCode = 'Select an App Code';
    else if (!canUseApp(req.user, appCode)) return res.status(403).json({ message: NO_ACCESS, errors: { appCode: NO_ACCESS } });
    if (!reason) errors.reason = 'Enter the reason';
    else if (reason.length > MAX_REASON) errors.reason = `At most ${MAX_REASON} characters`;
    if (Object.keys(errors).length) return res.status(422).json({ message: 'Please complete the form', errors });

    const [known] = await query('SELECT 1 AS ok FROM alert_criteria WHERE ALERT_CRITERIA_HOSTGROUP = ? LIMIT 1', [appCode]);
    if (!known) return res.status(422).json({ message: 'Unknown App Code', errors: { appCode: 'Unknown App Code' } });

    const info = await appInfo(appCode);
    Object.assign(errors, rules.validateWindow({ start: b.startDate, end: b.endDate, category: info.category, country: countryFor(info) }));
    if (Object.keys(errors).length) return res.status(422).json({ message: errors.appCode || 'Please correct the times', errors });

    const start = toDb(b.startDate);
    const end = toDb(b.endDate);
    const result = await query(
      `INSERT INTO maintenance_window
         (APPLICATION_ID, MAINTENANCE_START_DT, MAINTENANCE_END_DT, MAINTENANCE_START_TIME, MAINTENANCE_END_TIME,
          CHANGE_DESCRIPTION, INCIDENT_OR_CHANGE_RECORD_INFO, isActive, IS_GREEN_ZONE_ACTIVE,
          REQUESTER_NAME, EMAIL, CREATER_NAME, CREATED_DT, LAST_UPDATED_DT)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, NOW(), NOW())`,
      [appCode, start, end, start.slice(11), end.slice(11), reason, SYSTEM_RECORD_INFO,
        req.user.full_name || req.user.username, req.user.email || null, req.user.username]
    );
    // Email: requester + the App Code's SRE Leads, Cc support
    cbgmMail.blackoutSubmitted({ appCode, startDate: start.slice(0, 16), endDate: end.slice(0, 16), reason, user: req.user });
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    next(err);
  }
});

// GET /api/cbgm/blackout/windows -> { ongoing: [...], upcoming: [...] } (the user's own active windows)
router.get('/windows', async (req, res, next) => {
  try {
    const now = rules.nowSgt();
    const rows = await myWindows(req.user.username);
    res.json({
      ongoing: rows.filter((w) => phaseOf(w, now) === 'ongoing'),
      upcoming: rows.filter((w) => phaseOf(w, now) === 'upcoming'),
    });
  } catch (err) {
    next(err);
  }
});

const findMine = async (req) => (await myWindows(req.user.username)).find((w) => String(w.id) === String(req.params.id));

// PUT /api/cbgm/blackout/windows/:id
//   upcoming: { startDate, endDate, reason }   ongoing: { endDate } (start and reason stay as they are)
router.put('/windows/:id', async (req, res, next) => {
  try {
    const w = await findMine(req);
    if (!w) return res.status(404).json({ message: 'Window not found, already ended or cancelled' });
    if (!canUseApp(req.user, w.app_code)) return res.status(403).json({ message: NO_ACCESS });
    const b = req.body || {};
    const ongoing = phaseOf(w) === 'ongoing';
    const start = ongoing ? w.start_date : b.startDate;
    const reason = ongoing ? w.reason : str(b.reason);

    const errors = {};
    if (!ongoing && !reason) errors.reason = 'Enter the reason';
    else if (reason && reason.length > MAX_REASON) errors.reason = `At most ${MAX_REASON} characters`;
    const info = await appInfo(w.app_code);
    Object.assign(errors, rules.validateWindow({ start, end: b.endDate, category: info.category, country: countryFor(info), keepStart: ongoing }));
    if (Object.keys(errors).length) return res.status(422).json({ message: errors.appCode || 'Please correct the times', errors });

    const s = toDb(start);
    const e = toDb(b.endDate);
    await query(
      `UPDATE maintenance_window
          SET MAINTENANCE_START_DT = ?, MAINTENANCE_END_DT = ?, MAINTENANCE_START_TIME = ?, MAINTENANCE_END_TIME = ?,
              CHANGE_DESCRIPTION = ?, LAST_UPDATED_DT = NOW()
        WHERE MaintenanceWindowId = ?`,
      [s, e, s.slice(11), e.slice(11), reason, w.id]
    );
    res.json({ message: 'Window updated' });
  } catch (err) {
    next(err);
  }
});

// POST /api/cbgm/blackout/windows/:id/cancel  (upcoming windows only) -> isActive = 0
router.post('/windows/:id/cancel', async (req, res, next) => {
  try {
    const w = await findMine(req);
    if (!w) return res.status(404).json({ message: 'Window not found, already ended or cancelled' });
    if (phaseOf(w) !== 'upcoming') return res.status(422).json({ message: 'An ongoing window cannot be cancelled; change its end time instead' });
    await query('UPDATE maintenance_window SET isActive = 0, LAST_UPDATED_DT = NOW() WHERE MaintenanceWindowId = ?', [w.id]);
    res.json({ message: 'Window cancelled' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
