import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { cbgmApi as api } from '../../api/client';
import { PageHero } from '../../components/Layout';
import DataTable from '../../components/DataTable';
import MultiSelect from '../../components/MultiSelect';
import Offcanvas from '../../components/Offcanvas';
import { useToast } from '../../components/Toast';
import AlertDateFields, { enableOutOfRange } from './AlertDateFields';
import { useCbgmUrl } from './cbgmPages';
import { greeting, typeText } from '../../utils';

const show = (v) => (v === null || v === undefined || v === '' ? '—' : v);
// Fail Rate % values are stored as plain numbers (25) -> show "25%"
const percent = (v) => (show(v) === '—' ? '—' : String(v).trim().endsWith('%') ? v : `${String(v).trim()}%`);
// Long names without spaces (e.g. gen_s_cg_major_portfolios_buyby_power): allow a line break after _ . - /
const wrapName = (text) =>
  String(text).split(/(?<=[_.\-/])/).map((part, i) => (i ? [<wbr key={i} />, part] : part));
const statusLabel = (r) => (Number(r.alert_status) === 1 ? 'Active' : 'Inactive'); // alert_criteria.requiresnocupdate

// Main table columns (config_service_threshold + alert_criteria)
const COLUMNS = [
  { key: 'app_code', label: 'App Code', filter: 'select', render: (r) => <span className="fw-semibold">{r.app_code}</span> },
  { key: 'service_name', label: 'Service Name', className: 'cell-wrap', render: (r) => wrapName(show(r.service_name)) },
  { key: 'alert_type', label: 'Alert Type', filter: 'select', filterValue: (r) => typeText(r.alert_type), render: (r) => show(typeText(r.alert_type)) },
  { key: 'alert_level', label: 'Alert Level', filter: 'select', render: (r) => show(r.alert_level) },
  { key: 'low_conservative_points', label: 'Consecutive Point', className: 'text-center', render: (r) => show(r.low_conservative_points) },
  { key: 'operator', label: 'Operator', filter: 'select', className: 'text-center', render: (r) => show(r.operator) },
  { key: 'failure_percent', label: 'Fail Rate %', className: 'text-center', filterValue: (r) => percent(r.failure_percent), render: (r) => percent(r.failure_percent) },
  { key: 'high_conservative_point', label: 'Threshold', className: 'text-center', render: (r) => show(r.high_conservative_point) },
  {
    key: 'alert_status',
    label: 'Alert Status',
    className: 'text-center',
    filter: 'select',
    filterValue: statusLabel,
    sortValue: statusLabel,
    render: (r) => <span className={`badge status-badge ${statusLabel(r) === 'Active' ? 'text-bg-success' : 'text-bg-secondary'}`}>{statusLabel(r)}</span>,
  },
];

// Shown when a row's + is clicked
const DETAILS = [
  ['Hours Type', 'peak_hours'],
  ['SOP ID', 'sop_id'],
  ['Criteria ID', 'criteria_id', 'grow'], // same row, after SOP ID: takes the rest of the row, one line (scrolls if needed)
];

function Details({ row }) {
  return (
    <dl className="details-inline">
      {DETAILS.map(([label, key, cls]) => (
        <div key={key} className={cls === 'grow' ? 'details-grow' : undefined}>
          <dt>{label}</dt>
          <dd>{show(row[key])}</dd>
        </div>
      ))}
    </dl>
  );
}

const EMPTY_DATES = { disableDate: '', enableDate: '' };

/** CBGM Overview: pick App Codes, then list their alert thresholds. */
export default function CbgmHomePage() {
  const cbgmUrl = useCbgmUrl(); // CBGM page links (in /CBGM or /SRE/cbgm)
  const { user } = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState(null); // row being enabled / disabled (side panel)
  const [dates, setDates] = useState(EMPTY_DATES);
  const [dateErrors, setDateErrors] = useState({});
  const [sending, setSending] = useState(false);
  const [appCodes, setAppCodes] = useState(null); // null = loading
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState('');
  const [rows, setRows] = useState(null); // null = not searched yet
  const [loading, setLoading] = useState(false);
  const [searchedCodes, setSearchedCodes] = useState([]); // App Codes of the rows shown (for the Excel report)
  const [report, setReport] = useState(false); // Download Report switch: a button in the table header downloads Excel
  const [downloading, setDownloading] = useState(false);

  // App Code options: distinct alert_criteria.ALERT_CRITERIA_HOSTGROUP
  useEffect(() => {
    api.get('/overview/app-codes').then(setAppCodes).catch(() => setAppCodes([]));
  }, []);

  const search = useCallback(async (codes) => {
    if (!codes.length) return setError('Select at least one App Code');
    setError('');
    setLoading(true);
    try {
      setRows(await api.post('/overview/thresholds', { appCodes: codes }));
      setSearchedCodes(codes);
    } catch (ex) {
      setError(ex.message);
    } finally {
      setLoading(false);
    }
  }, []);
  const submit = (e) => {
    e.preventDefault();
    search(selected);
  };

  // Download Report button (table header): every row of the searched App Codes as an Excel file (all records,
  // not only the page shown)
  const download = async () => {
    setDownloading(true);
    try {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      await api.download(`/overview/thresholds/download?appCodes=${encodeURIComponent(searchedCodes.join(','))}`,
        `Alert_Overview_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.xlsx`);
      toast('success', 'Alert overview report downloaded.');
    } catch (ex) {
      toast('danger', ex.message);
    } finally {
      setDownloading(false);
    }
  };

  // My Applications: the App Codes in my Application list (user table) -> select them and show their alerts
  const showMine = async () => {
    try {
      const mine = await api.get('/overview/my-app-codes', { spin: true });
      if (!mine.length) return toast('warning', 'No App Codes are assigned to you. Contact CBGM Support Team to assign application to you');
      setSelected(mine);
      search(mine);
    } catch (ex) {
      toast('danger', ex.message);
    }
  };

  // Edit (Alert Status): same request as Alert Enable/Disable Requests (Active -> disable + enable dates, Inactive -> enable date)
  const isActive = editing ? Number(editing.alert_status) === 1 : false;
  const openEdit = (r) => {
    setEditing(r);
    setDates(EMPTY_DATES);
    setDateErrors({});
  };
  const closeEdit = useCallback(() => setEditing(null), []);
  const setDate = (k, v) => {
    setDates((d) => {
      const next = { ...d, [k]: v };
      if (k === 'disableDate' && enableOutOfRange(v, d.enableDate)) next.enableDate = '';
      return next;
    });
    setDateErrors((e) => ({ ...e, [k]: undefined }));
  };
  const sendRequest = async () => {
    const err = {};
    if (isActive && !dates.disableDate) err.disableDate = 'Choose the Alert Disable Date';
    if (!dates.enableDate) err.enableDate = 'Choose the Alert Enable Date';
    setDateErrors(err);
    if (Object.keys(err).length) return;
    setSending(true);
    try {
      const r = await api.post('/alert-requests', {
        appCode: editing.app_code,
        alertLevel: editing.ac_alert_level,
        alertType: editing.ac_alert_type,
        criteriaUid: editing.criteria_id,
        disableDate: isActive ? dates.disableDate : '',
        enableDate: dates.enableDate,
      });
      toast('success', `Request to ${r.action} ${editing.criteria_id} was submitted and is in the Queue (see My Request).`);
      setEditing(null);
    } catch (ex) {
      setDateErrors(ex.errors || {});
      toast('danger', ex.message);
    } finally {
      setSending(false);
    }
  };

  // Columns + Edit (only for my App Codes: can_edit from the server)
  const columns = [
    ...COLUMNS,
    {
      key: 'edit',
      label: '', // no header text, only the edit button in each row
      ariaLabel: 'Edit',
      sortable: false,
      filter: false,
      className: 'text-center',
      render: (r) =>
        r.can_edit ? (
          <button type="button" className="btn btn-sm btn-outline-primary" title={Number(r.alert_status) === 1 ? 'Disable this alert' : 'Enable this alert'}
            aria-label={`Enable or disable ${r.criteria_id}`} onClick={() => openEdit(r)}>
            <i className="bi bi-pencil-square" />
          </button>
        ) : null,
    },
  ];

  const fullName = String(user.full_name || user.username).trim(); // first + last name from the `user` table

  return (
    <>
      <PageHero
        greeting={<>{greeting()}, {fullName}</>}
        title="Alert Overview Dashboard"
      />

      <div className="page-body">
        <div className="card mb-4">
          <div className="card-body p-4">
            <form className="row g-3" onSubmit={submit} noValidate>
              {/* full width: many selected App Codes line up across the card */}
              <div className="col-12">
                <label className="form-label fw-semibold" htmlFor="ov-app-codes">App Code <span className="text-danger">*</span></label>
                <MultiSelect
                  id="ov-app-codes"
                  options={appCodes || []}
                  value={selected}
                  onChange={(v) => { setSelected(v); setError(''); }}
                  placeholder={appCodes === null ? 'Loading App Codes...' : appCodes.length ? 'Select App Codes...' : 'No App Codes found'}
                  invalid={!!error}
                />
                {error && <div className="invalid-feedback d-block">{error}</div>}
              </div>
              {/* buttons under the dropdown */}
              <div className="col-12 d-flex flex-wrap align-items-center gap-2">
                <button type="submit" className="btn btn-primary px-4" disabled={loading || appCodes === null}>
                  {loading ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bi bi-search me-1" />}
                  Submit
                </button>
                <button type="button" className="btn btn-outline-primary" onClick={showMine} disabled={loading}>
                  <i className="bi bi-person-check me-1" />My Applications
                </button>
                {/* Download Report: shows a Download Report button in the table header (Excel, all records) */}
                <div className="form-check form-switch form-switch-lg mb-0 ms-3">
                  <input id="ov-report" className="form-check-input" type="checkbox" role="switch" checked={report} onChange={(e) => setReport(e.target.checked)} />
                  <label className="form-check-label fw-semibold" htmlFor="ov-report"><i className="bi bi-file-earmark-excel me-1 text-success" />Download Report</label>
                </div>
              </div>
            </form>
          </div>
        </div>

        {rows !== null && (
          <div className="card">
            <DataTable
              columns={columns}
              rows={rows}
              loading={loading}
              emptyText="No thresholds found for the selected App Codes"
              renderDetails={(r) => <Details row={r} />}
              toolbar={
                <>
                  {report && (
                    <button type="button" className="btn btn-sm btn-outline-success text-nowrap" onClick={download} disabled={!rows.length || loading || downloading}>
                      {downloading ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bi bi-file-earmark-excel me-1" />}Download Report
                    </button>
                  )}
                  {user.cbgm_role !== 'VIEWER' && ( // VIEWER: no Onboard New Alerts (view only)
                    <Link to={cbgmUrl('onboardAlerts')} className="btn btn-sm btn-primary text-nowrap">
                      <i className="bi bi-plus-circle me-1" />Onboard New Alerts
                    </Link>
                  )}
                </>
              }
            />
          </div>
        )}

        {/* Edit: enable / disable this alert (Alert Enable/Disable Request) */}
        <Offcanvas
        wide
          show={!!editing}
          title={isActive ? 'Disable Alert' : 'Enable Alert'}
          onClose={closeEdit}
          footer={
            <>
              <button type="button" className="btn btn-outline-secondary" onClick={closeEdit} disabled={sending}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={sendRequest} disabled={sending}>
                <i className="bi bi-send me-1" />Submit Request
              </button>
            </>
          }
        >
          {editing && (
            <>
              <dl className="edit-summary mb-3">
                <dt>App Code</dt><dd>{editing.app_code}</dd>
                <dt>Service</dt><dd className="text-break">{show(editing.service_name)}</dd>
                <dt>Alert Type</dt><dd>{show(typeText(editing.alert_type))}</dd>
                <dt>Alert Level</dt><dd>{show(editing.alert_level)}</dd>
                <dt>Criteria ID</dt><dd className="text-break small">{editing.criteria_id}</dd>
                <dt>Alert Status</dt>
                <dd><span className={`badge ${isActive ? 'text-bg-success' : 'text-bg-secondary'}`}>{isActive ? 'Active' : 'Inactive'}</span></dd>
              </dl>
              <div className="row g-3">
                <AlertDateFields idPrefix="ov" isDisable={isActive} values={dates} onChange={setDate} errors={dateErrors} />
              </div>
              <p className="small text-body-secondary mt-3 mb-0">
                {isActive ? 'The alert is disabled at the Disable Date and enabled again at the Enable Date (at most 72 hours later).' : 'The alert is enabled at the Enable Date.'}{' '}
                The request goes to the Queue, the SRE Leads are emailed, and it appears in <Link to={cbgmUrl('myRequests')}>My Request</Link>.
              </p>
            </>
          )}
        </Offcanvas>
      </div>
    </>
  );
}
