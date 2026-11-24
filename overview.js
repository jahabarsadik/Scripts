const express = require('express');
const { query } = require('../../services/db');
const { canUseApp, allAppCodes, filterAppCodes } = require('../../services/cbgm/appAccess');

// CBGM Overview: alert thresholds per App Code
//   config_service_threshold.criteria_id = alert_criteria.ALERT_CRITERIA_UID
const router = express.Router();

// GET /api/cbgm/overview/app-codes -> ['APP1', 'APP2', ...]: the App Codes in config_service_threshold; non-admins only
// those matching their user.APPLICATION, administrators all of them (services/cbgm/appAccess.js)
router.get('/app-codes', async (req, res, next) => {
  try {
    res.json(filterAppCodes(req.user, await allAppCodes()));
  } catch (err) {
    next(err);
  }
});

// GET /api/cbgm/overview/my-app-codes -> the user's own App Codes (user.APPLICATION) that are in config_service_threshold
// ("My App Code" button; also for administrators: their own App Codes only)
router.get('/my-app-codes', async (req, res, next) => {
  try {
    const own = new Set((req.user && Array.isArray(req.user.applications) ? req.user.applications : []).map((a) => String(a).trim().toUpperCase()));
    res.json((await allAppCodes()).filter((a) => own.has(a.toUpperCase())));
  } catch (err) {
    next(err);
  }
});

// POST /api/cbgm/overview/thresholds  { appCodes: ['APP1', ...] } -> threshold rows for those App Codes
router.post('/thresholds', async (req, res, next) => {
  try {
    const appCodes = [].concat(req.body.appCodes || []).map(String).filter(Boolean);
    if (!appCodes.length) {
      return res.status(422).json({ message: 'Select at least one App Code', errors: { appCodes: 'Select at least one App Code' } });
    }
    const rows = await query(
      `SELECT cst.id,
              cst.app_code, cst.config_header, cst.service_name, cst.peak_hours, cst.alert_type, cst.alert_level,
              cst.low_conservative_points, cst.operator, cst.failure_percent, cst.high_conservative_point,
              ac.requiresnocupdate + 0 AS alert_status, -- BIT(1) -> 0 / 1
              ac.SOP_ID AS sop_id, cst.criteria_id,
              ac.alertLevel AS ac_alert_level, ac.alertType AS ac_alert_type -- as stored in alert_criteria (for Enable/Disable requests)
         FROM config_service_threshold cst
         JOIN alert_criteria ac ON ac.ALERT_CRITERIA_UID = cst.criteria_id
        WHERE ac.ALERT_CRITERIA_HOSTGROUP IN (?)
        ORDER BY cst.app_code, cst.service_name, cst.id`,
      [appCodes]
    );
    // can_edit: the user may raise an Enable/Disable request for this App Code (user.APPLICATION)
    res.json(rows.map((r) => ({ ...r, can_edit: canUseApp(req.user, r.app_code) })));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
