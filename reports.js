const express = require('express');
const { query } = require('../../services/db');
const { buildXlsx } = require('../../services/xlsx');
const { setupProblem } = require('../../services/cbgm/tier2Requests');
const { canUseApp } = require('../../services/cbgm/appAccess');

// CBGM Reports: all records of the chosen request types, shown on screen and downloadable as one
// Excel workbook (one sheet per type). ADMIN: every App Code; APP USER and VIEWER: only rows of their assigned App
// Codes (user.APPLICATION, services/cbgm/appAccess.js).
//   onboarding    -> alert_onboard_request          ("New Alert Onboard Request")
//   threshold     -> config_service_threshold_history ("Update Threshold Request")
//   alertRequests -> cbgm_alert_request             ("Alert Enable-Disable Request")
//   tier2         -> c2e_mtj_journey_app_request    ("Tier-2 Journey Request", Add and Edit requests: Request Type)
const router = express.Router();

const fmt = (col) => `DATE_FORMAT(${col}, '%Y-%m-%d %H:%i:%s')`;
const name = (alias, idCol) => `COALESCE(NULLIF(${alias}.USERNAME, ''), ${idCol})`;
const yesNo = (v) => (v === null || v === undefined ? '' : Number(v) === 1 ? 'Yes' : 'No');

const REPORTS = {
  onboarding: {
    title: 'New Alert Onboard Request',
    sql: `SELECT COALESCE(s.app_code, di.app_code) AS app_code, di.index_name, sm.service_name,
                 r.alert_type, r.alert_level, r.consecutive_points, r.threshold, r.snoc_flag, r.remarks,
                 rp.\`1bank_id\` AS requested_by, NULLIF(TRIM(CONCAT_WS(' ', rp.first_name, rp.last_name)), '') AS requested_by_name,
                 r.requested_client_ip, ${fmt('r.requested_time')} AS requested_time,
                 s.sre_lead_id AS sre_lead, ${name('lu', 's.sre_lead_id')} AS sre_lead_name,
                 COALESCE(NULLIF(r.sre_lead_approval_status, ''), 'Open') AS sre_status, ${fmt('r.sre_lead_approval_time')} AS sre_time, r.sre_lead_remarks,
                 ap.\`1bank_id\` AS cbgm_approver, NULLIF(TRIM(CONCAT_WS(' ', ap.first_name, ap.last_name)), '') AS cbgm_approver_name,
                 r.cbgm_approval_status, ${fmt('r.cbgm_approval_time')} AS cbgm_time, r.cbgm_approver_remarks
            FROM alert_onboard_request r
            LEFT JOIN cbgm_sre_lead_apps s ON s.id = r.sre_lead_id
            LEFT JOIN user lu ON lu.LOGINID = s.sre_lead_id
            LEFT JOIN cbgm_daily_service_monitoring sm ON sm.id = r.service_id
            LEFT JOIN cbgm_daily_index di ON di.id = sm.index_id
            LEFT JOIN cbgm_portal_users rp ON rp.id = r.requested_by
            LEFT JOIN cbgm_portal_users ap ON ap.id = r.cbgm_approval_id
           ORDER BY r.requested_time DESC, r.id DESC`,
    map: (r) => ({ ...r, snoc_flag: yesNo(r.snoc_flag) }),
    columns: [
      { header: 'App Code', key: 'app_code' },
      { header: 'Index', key: 'index_name', width: 30 },
      { header: 'Service Name', key: 'service_name', width: 45 },
      { header: 'Alert Type', key: 'alert_type' },
      { header: 'Alert Level', key: 'alert_level' },
      { header: 'Consecutive Point', key: 'consecutive_points' },
      { header: 'Threshold', key: 'threshold' },
      { header: 'SNOC', key: 'snoc_flag' },
      { header: 'Remarks', key: 'remarks', width: 40 },
      { header: 'Requested By', key: 'requested_by', width: 16 },
      { header: 'Requested By Name', key: 'requested_by_name', width: 22 },
      { header: 'Requested Client IP', key: 'requested_client_ip', width: 18 },
      { header: 'Requested Time', key: 'requested_time', width: 20 },
      { header: 'SRE Lead', key: 'sre_lead', width: 16 },
      { header: 'SRE Lead Name', key: 'sre_lead_name', width: 22 },
      { header: 'SRE Lead Approval', key: 'sre_status', width: 18 },
      { header: 'SRE Lead Approval Time', key: 'sre_time', width: 22 },
      { header: 'SRE Lead Remarks', key: 'sre_lead_remarks', width: 30 },
      { header: 'CBGM Approver', key: 'cbgm_approver', width: 16 },
      { header: 'CBGM Approver Name', key: 'cbgm_approver_name', width: 22 },
      { header: 'CBGM Approval', key: 'cbgm_approval_status', width: 16 },
      { header: 'CBGM Approval Time', key: 'cbgm_time', width: 20 },
      { header: 'CBGM Remarks', key: 'cbgm_approver_remarks', width: 30 },
    ],
  },
  threshold: {
    title: 'Update Threshold Request',
    sql: `SELECT h.app_code, h.config_header, h.service_name, h.peak_hours, t.alert_type, t.alert_level,
                 h.old_low_conservative_points AS old_low, h.new_low_conservative_points AS new_low,
                 h.old_failure_percent AS old_failure, h.new_failure_percent AS new_failure,
                 h.old_high_conservative_point AS old_high, h.new_high_conservative_point AS new_high,
                 h.approved_by, ${name('au', 'h.approved_by')} AS approver_name, h.approval_status, ${fmt('h.approved_time')} AS approved_time,
                 h.request_by, ${name('ru', 'h.request_by')} AS requester_name, h.client_ip, ${fmt('h.change_time')} AS requested_time
            FROM config_service_threshold_history h
            LEFT JOIN config_service_threshold t ON t.id = h.threshold_id
            LEFT JOIN user au ON au.LOGINID = h.approved_by
            LEFT JOIN user ru ON ru.LOGINID = h.request_by
           ORDER BY h.change_time DESC, h.id DESC`,
    columns: [
      { header: 'App Code', key: 'app_code' },
      { header: 'Threshold Type', key: 'config_header', width: 40 },
      { header: 'Service Name', key: 'service_name', width: 45 },
      { header: 'Hours Type', key: 'peak_hours' },
      { header: 'Alert Type', key: 'alert_type' },
      { header: 'Alert Level', key: 'alert_level' },
      { header: 'Old Consecutive Point', key: 'old_low' },
      { header: 'New Consecutive Point', key: 'new_low' },
      { header: 'Old Fail Rate %', key: 'old_failure' },
      { header: 'New Fail Rate %', key: 'new_failure' },
      { header: 'Old Threshold Value', key: 'old_high' },
      { header: 'New Threshold Value', key: 'new_high' },
      { header: 'SRE Lead', key: 'approved_by', width: 16 },
      { header: 'SRE Lead Name', key: 'approver_name', width: 22 },
      { header: 'Approval Status', key: 'approval_status', width: 16 },
      { header: 'Approved Time', key: 'approved_time', width: 20 },
      { header: 'Requested By', key: 'request_by', width: 16 },
      { header: 'Requested By Name', key: 'requester_name', width: 22 },
      { header: 'Client IP', key: 'client_ip', width: 16 },
      { header: 'Requested Time', key: 'requested_time', width: 20 },
    ],
  },
  alertRequests: {
    title: 'Alert Enable-Disable Request',
    sql: `SELECT ac.ALERT_CRITERIA_HOSTGROUP AS app_code, ac.alertType AS alert_type, ac.alertLevel AS alert_level,
                 ac.ALERT_CRITERIA_UID AS criteria_uid, r.require_snoc_flag + 0 AS snoc_flag,
                 ${fmt('r.request_start_date')} AS start_date, ${fmt('r.request_end_date')} AS end_date,
                 r.update_status, r.approved_status, r.approved_by, ${fmt('r.approved_time')} AS approved_time,
                 r.request_by, ${name('ru', 'r.request_by')} AS requester_name, r.client_remote_address,
                 ${fmt('r.request_date')} AS requested_time, r.update_by, ${fmt('r.update_date')} AS update_date
            FROM cbgm_alert_request r
            LEFT JOIN alert_criteria ac ON ac.alertCriteriaId = r.alert_criteria_id
            LEFT JOIN user ru ON ru.LOGINID = r.request_by
           ORDER BY r.request_date DESC, r.alert_request_id DESC`,
    // require_snoc_flag 0 = disable request (start = Disable Date, end = Enable Date); 1 = enable request (start = Enable Date)
    map: (r) => {
      const disable = Number(r.snoc_flag) === 0;
      const { snoc_flag, start_date, end_date, ...rest } = r;
      return { ...rest, action: disable ? 'Disable' : 'Enable', disable_date: disable ? start_date : null, enable_date: disable ? end_date : start_date };
    },
    columns: [
      { header: 'App Code', key: 'app_code' },
      { header: 'Alert Type', key: 'alert_type' },
      { header: 'Alert Level', key: 'alert_level' },
      { header: 'Criteria ID', key: 'criteria_uid', width: 60 },
      { header: 'Request', key: 'action' },
      { header: 'Disable Date', key: 'disable_date', width: 20 },
      { header: 'Enable Date', key: 'enable_date', width: 20 },
      { header: 'Status', key: 'update_status', width: 16 },
      { header: 'Approval Status', key: 'approved_status', width: 16 },
      { header: 'Approved By', key: 'approved_by', width: 16 },
      { header: 'Approved Time', key: 'approved_time', width: 20 },
      { header: 'Requested By', key: 'request_by', width: 16 },
      { header: 'Requested By Name', key: 'requester_name', width: 22 },
      { header: 'Client IP', key: 'client_remote_address', width: 18 },
      { header: 'Requested Time', key: 'requested_time', width: 20 },
      { header: 'Updated By', key: 'update_by', width: 16 },
      { header: 'Updated Time', key: 'update_date', width: 20 },
    ],
  },
  tier2: {
    title: 'Tier-2 Journey Request',
    sql: `SELECT COALESCE(NULLIF(r.request_type, ''), 'Add') AS request_type, r.valid_id,
                 r.app_code, r.mtj_journey, r.journey_name, r.health_id, r.service_name, r.kafka_name, r.monitoring_type,
                 r.approver_1bank_id, ${name('ua', 'r.approver_1bank_id')} AS approver_name,
                 COALESCE(NULLIF(r.approver_status, ''), 'Open') AS approver_status, r.approver_remarks,
                 ${fmt('r.approver_time')} AS approver_time,
                 r.requester_by, ${name('ur', 'r.requester_by')} AS requester_name, ${fmt('r.requested_time')} AS requested_time
            FROM c2e_mtj_journey_app_request r
            LEFT JOIN user ua ON ua.LOGINID = r.approver_1bank_id
            LEFT JOIN user ur ON ur.LOGINID = r.requester_by
           ORDER BY r.requested_time DESC, r.id DESC`,
    // Alert Type as on My Request / My Approval; Requested Status (Active / Inactive) for Edit requests only
    map: (r) => ({
      ...r,
      monitoring_type: TIER2_TYPES[r.monitoring_type] || r.monitoring_type,
      requested_status: String(r.request_type).toLowerCase() === 'edit' ? (Number(r.valid_id) === 0 ? 'Inactive' : 'Active') : '',
    }),
    columns: [
      { header: 'Request Type', key: 'request_type', width: 12 },
      { header: 'App Code', key: 'app_code' },
      { header: 'MTJ Journey', key: 'mtj_journey', width: 40 },
      { header: 'Journey Name', key: 'journey_name', width: 30 },
      { header: 'Health Check ID', key: 'health_id', width: 20 },
      { header: 'Service Name', key: 'service_name', width: 40 },
      { header: 'Kafka Name', key: 'kafka_name', width: 40 },
      { header: 'Alert Type', key: 'monitoring_type', width: 16 },
      { header: 'Requested Status', key: 'requested_status', width: 16 },
      { header: 'Approver', key: 'approver_1bank_id', width: 16 },
      { header: 'Approver Name', key: 'approver_name', width: 22 },
      { header: 'Approver Status', key: 'approver_status', width: 16 },
      { header: 'Approver Remarks', key: 'approver_remarks', width: 30 },
      { header: 'Approver Decision Time', key: 'approver_time', width: 22 },
      { header: 'Requested By', key: 'requester_by', width: 16 },
      { header: 'Requested By Name', key: 'requester_name', width: 22 },
      { header: 'Requested Time', key: 'requested_time', width: 20 },
    ],
  },
};
const TIER2_TYPES = { response_time: 'Response Time', throughput: 'Throughput', technical_error: 'Technical Fails', business_error: 'Business Fails' };
const ORDER = ['onboarding', 'threshold', 'alertRequests', 'tier2'];

/** ?types=onboarding,threshold -> ['onboarding', 'threshold'] (known types only, report order) */
const typesOf = (req) => {
  const wanted = String(req.query.types || '').split(',').map((t) => t.trim());
  return ORDER.filter((t) => wanted.includes(t));
};

/** { [type]: rows }, plus notes: { [type]: message } for a report whose table is not ready (Tier-2: app_code column
 *  not renamed yet) - that report is empty, the others still load. Only the rows of App Codes this user may see
 *  (ADMIN: all; others: user.APPLICATION). The reports are read at the same time. */
async function load(types, user) {
  const out = {};
  const notes = {};
  await Promise.all(types.map(async (t) => {
    try {
      const rows = (await query(REPORTS[t].sql)).filter((r) => canUseApp(user, r.app_code));
      out[t] = REPORTS[t].map ? rows.map(REPORTS[t].map) : rows;
    } catch (err) {
      const problem = t === 'tier2' && setupProblem(err);
      if (!problem) throw err;
      out[t] = [];
      notes[t] = problem;
    }
  }));
  return { out, notes };
}

// GET /api/cbgm/reports?types=onboarding,threshold,alertRequests
//   -> { onboarding: { title, columns, rows }, ... }
router.get('/', async (req, res, next) => {
  try {
    const types = typesOf(req);
    if (!types.length) return res.status(422).json({ message: 'Select at least one report' });
    const { out: data, notes } = await load(types, req.user);
    res.json(Object.fromEntries(types.map((t) => [t, { title: REPORTS[t].title, columns: REPORTS[t].columns, rows: data[t], ...(notes[t] ? { note: notes[t] } : {}) }])));
  } catch (err) {
    next(err);
  }
});

// GET /api/cbgm/reports/download?types=... -> CBGM_Report_YYYYMMDD_HHmm.xlsx (one sheet per report)
router.get('/download', async (req, res, next) => {
  try {
    const types = typesOf(req);
    if (!types.length) return res.status(422).json({ message: 'Select at least one report' });
    const { out: data } = await load(types, req.user);
    const file = buildXlsx(types.map((t) => ({ name: REPORTS[t].title, columns: REPORTS[t].columns, rows: data[t] })));
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const filename = `CBGM_Report_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.xlsx`;
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

module.exports = router;
