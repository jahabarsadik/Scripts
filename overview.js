const express = require('express');
const { query } = require('../../services/db');
const { canUseApp, allAppCodes, filterAppCodes } = require('../../services/cbgm/appAccess');
const { buildXlsx } = require('../../services/xlsx');
const { isViewer } = require('../../services/cbgm/cbgmRole');

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

// Threshold rows (config_service_threshold + alert_criteria) for the chosen App Codes; a non-admin only gets the App
// Codes they may use (user.APPLICATION). null + 422 sent when none is chosen. Used by the table and the Excel report.
async function thresholdRows(req, res, appCodes) {
  const chosen = filterAppCodes(req.user, [...new Set(appCodes.map((a) => String(a).trim()).filter(Boolean))]);
  if (!chosen.length) {
    res.status(422).json({ message: 'Select at least one App Code', errors: { appCodes: 'Select at least one App Code' } });
    return null;
  }
  return query(
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
    [chosen]
  );
}

// POST /api/cbgm/overview/thresholds  { appCodes: ['APP1', ...] } -> threshold rows for those App Codes
router.post('/thresholds', async (req, res, next) => {
  try {
    const rows = await thresholdRows(req, res, [].concat((req.body && req.body.appCodes) || []));
    if (!rows) return;
    // can_edit: the user may raise an Enable/Disable request for this App Code (user.APPLICATION); never a VIEWER
    const viewer = isViewer(req.user);
    res.json(rows.map((r) => ({ ...r, can_edit: !viewer && canUseApp(req.user, r.app_code) })));
  } catch (err) {
    next(err);
  }
});

// Excel report columns: the table's columns, then the + details
const REPORT_COLUMNS = [
  { header: 'App Code', key: 'app_code', width: 14 },
  { header: 'Service Name', key: 'service_name', width: 50 },
  { header: 'Alert Type', key: 'alert_type', width: 16 },
  { header: 'Alert Level', key: 'alert_level', width: 12 },
  { header: 'Consecutive Point', key: 'low_conservative_points', width: 18 },
  { header: 'Operator', key: 'operator', width: 10 },
  { header: 'Fail Rate %', key: 'failure_percent', width: 12 },
  { header: 'Threshold', key: 'high_conservative_point', width: 12 },
  { header: 'Alert Status', key: 'status', width: 12 },
  { header: 'Hours Type', key: 'peak_hours', width: 14 },
  { header: 'SOP ID', key: 'sop_id', width: 16 },
  { header: 'Criteria ID', key: 'criteria_id', width: 44 },
  { header: 'Config Header', key: 'config_header', width: 30 },
];
const percent = (v) => (v === null || v === undefined || String(v).trim() === '' ? '' : String(v).trim().endsWith('%') ? String(v).trim() : `${String(v).trim()}%`);

// GET /api/cbgm/overview/thresholds/download?appCodes=A,B -> every threshold row of those App Codes as an Excel file
// (all records, not only the page shown in the table)
router.get('/thresholds/download', async (req, res, next) => {
  try {
    const rows = await thresholdRows(req, res, String(req.query.appCodes || '').split(','));
    if (!rows) return;
    const file = buildXlsx([{
      name: 'Alert Overview',
      columns: REPORT_COLUMNS,
      rows: rows.map((r) => ({
        ...r,
        alert_type: r.alert_type ? String(r.alert_type).replace(/_/g, ' ') : '',
        failure_percent: percent(r.failure_percent),
        status: Number(r.alert_status) === 1 ? 'Active' : 'Inactive',
      })),
    }]);
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const filename = `Alert_Overview_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send(file);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
