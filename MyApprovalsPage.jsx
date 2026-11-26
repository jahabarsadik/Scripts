import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { cbgmApi as api } from '../../api/client';
import DataTable from '../../components/DataTable';
import Offcanvas from '../../components/Offcanvas';
import Modal from '../../components/Modal';
import Tabs from '../../components/Tabs';
import ConfirmDialog from '../../components/ConfirmDialog';
import { thresholdText } from './thresholdFormat';
import LongText from '../../components/LongText';
import { useToast } from '../../components/Toast';
import { useAuth } from '../../context/AuthContext';
import PersonCell from '../../components/PersonCell';
import { typeText } from '../../utils';
import { refreshPendingApprovals } from '../../components/usePendingApprovals';

// SNOC alert: green tick = required, red cross = not required (the filter still lists Yes / No)
const snocIcon = (r) =>
  Number(r.snoc_flag) === 1
    ? <i className="bi bi-check-circle-fill text-success fs-5" title="SNOC alert required" aria-label="Yes" />
    : <i className="bi bi-x-circle-fill text-danger fs-5" title="No SNOC alert" aria-label="No" />;
const show = (v) => (v === null || v === undefined || v === '' ? '—' : v);
// Alert Level colour: FATAL red, WARNING yellow
const levelBadge = (l) => ({ FATAL: 'text-bg-danger', WARNING: 'text-bg-warning' })[String(l).toUpperCase()] || 'text-bg-light border';
const fmt = (s) => {
  if (!s) return '—';
  const [d, t] = s.split(' ');
  const [y, m, day] = d.split('-');
  return `${day} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1]} ${y}, ${t}`;
};
const requester = (r) => (r.requester_name && r.requester_name !== r.request_by ? `${r.requester_name} (${r.request_by})` : show(r.request_by));

// "3 → 4" (changed values in blue), "5000" when unchanged, "—" when empty; percent for Fail Rate
function OldNew({ oldValue, newValue, unit = '' }) {
  const o = show(oldValue);
  const n = show(newValue);
  const withUnit = (v) => (v !== '—' && unit ? `${v}${unit}` : v);
  if (String(o) === String(n)) return <span className="text-body-secondary">{withUnit(o)}</span>;
  return (
    <span className="text-nowrap">
      <span className="text-body-secondary">{withUnit(o)}</span> <i className="bi bi-arrow-right mx-1" />
      <span className="fw-bold text-primary">{withUnit(n)}</span>
    </span>
  );
}

const THRESHOLD_COLUMNS = [
  { key: 'app_code', label: 'App Code', filter: 'select', render: (r) => <span className="fw-semibold">{r.app_code}</span> },
  { key: 'service_name', label: 'Service Name', className: 'wrap-cell', render: (r) => <span className="text-break">{r.service_name}</span> },
  { key: 'alert_type', label: 'Alert Type', filter: 'select', filterValue: (r) => typeText(r.alert_type), render: (r) => show(typeText(r.alert_type)) },
  { key: 'alert_level', label: 'Alert Level', filter: 'select', render: (r) => show(r.alert_level) },
  { key: 'peak_hours', label: 'Hours Type', filter: 'select', render: (r) => show(r.peak_hours) },
  { key: 'low', label: 'Consecutive Point', sortable: false, filter: false, className: 'text-center', render: (r) => <OldNew oldValue={r.old_low} newValue={r.new_low} /> },
  { key: 'failure', label: 'Fail Rate %', sortable: false, filter: false, className: 'text-center', render: (r) => <OldNew oldValue={r.old_failure} newValue={r.new_failure} unit="%" /> },
  { key: 'high', label: 'Threshold Value', sortable: false, filter: false, className: 'text-center', render: (r) => <OldNew oldValue={r.old_high} newValue={r.new_high} /> },
];

// Update Threshold: shown when a row's + is clicked
function ThresholdDetails({ row }) {
  return (
    <dl className="details-list">
      <div>
        <dt>Requested By</dt>
        <dd>{requester(row)}</dd>
      </div>
      <div>
        <dt>Requested On</dt>
        <dd>{fmt(row.requested_time)}</dd>
      </div>
    </dl>
  );
}

// SRE Lead decision badge (Approved / Rejected / Open)
const SRE_BADGE = { approved: 'text-bg-success', rejected: 'text-bg-danger' };
const sreStatus = (r) => <span className={`badge ${SRE_BADGE[String(r.sre_status).toLowerCase()] || 'text-bg-warning'}`}>{show(r.sre_status)}</span>;
const sreLead = (r) => (r.sre_lead_name && r.sre_lead_name !== r.sre_lead ? `${r.sre_lead_name} (${r.sre_lead})` : show(r.sre_lead));

const ONBOARDING_COLUMNS = [
  { key: 'app_code', label: 'App Code', filter: 'select', render: (r) => <span className="fw-semibold">{show(r.app_code)}</span> },
  { key: 'service_name', label: 'Service Name', className: 'wrap-cell', render: (r) => <span className="text-break">{show(r.service_name)}</span> },
  { key: 'alert_type', label: 'Alert Type', filter: 'select', filterValue: (r) => typeText(r.alert_type), render: (r) => typeText(r.alert_type) },
  { key: 'alert_level', label: 'Alert Level', filter: 'select' },
  { key: 'consecutive_points', label: 'Consecutive Point', className: 'text-center', render: (r) => (Number(r.consecutive_points) === 0 ? '—' : show(r.consecutive_points)) }, // 0 = threshold not configured
  { key: 'operator', label: 'Operator', filter: 'select', className: 'text-center', filterValue: (r) => ((Number(r.consecutive_points) > 0) ? show(r.operator) : '—'), render: (r) => ((Number(r.consecutive_points) > 0) ? show(r.operator) : '—') }, // <= / >= (none when the threshold is not configured)
  { key: 'threshold', label: 'Threshold/Fail Rate', className: 'text-center', render: (r) => thresholdText(r.threshold, r.alert_type) }, // Fail Rate in %
  {
    key: 'snoc_flag',
    label: 'SNOC configured?',
    filter: 'select',
    className: 'text-center',
    filterValue: (r) => (Number(r.snoc_flag) === 1 ? 'Yes' : 'No'),
    render: snocIcon,
  },
];

// "Threshold not configured" view: these columns are empty there, so they are left out (remarks show under +)
const NOT_CONFIGURED_HIDDEN = ['consecutive_points', 'operator', 'threshold', 'snoc_flag'];

// New Alert Onboarding: shown when a row's + is clicked
function OnboardingDetails({ row }) {
  return (
    <dl className="details-list">
      <div><dt>Index</dt><dd className="text-break">{show(row.index_name)}</dd></div>
      <div><dt>Requester Remarks</dt><dd className="text-break"><LongText text={row.remarks} title="Requester Remarks" /></dd></div>
      {/* SRE Lead and their decision (step 1 rows: the SRE Lead is you, still Open) */}
      <div><dt>SRE Lead</dt><dd>{sreLead(row)}</dd></div>
      <div><dt>SRE Lead Approval</dt><dd>{sreStatus(row)}</dd></div>
      {row.stage === 'cbgm' && (
        <>
          <div><dt>SRE Lead Decision On</dt><dd>{fmt(row.sre_time)}</dd></div>
          <div><dt>SRE Lead Remarks</dt><dd className="text-break"><LongText text={row.sre_lead_remarks} title="SRE Lead Remarks" /></dd></div>
        </>
      )}
      <div><dt>Requested By</dt><dd>{requester(row)}</dd></div>
      <div><dt>Requested On</dt><dd>{fmt(row.requested_time)}</dd></div>
    </dl>
  );
}

/** Approve ⇄ Reject switch (Approve by default) */
function DecisionToggle({ value, onChange, label }) {
  const reject = value === 'reject';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={reject}
      aria-label={`${label}: ${reject ? 'Reject' : 'Approve'} (click to switch)`}
      className={`decision-toggle ${reject ? 'is-reject' : 'is-approve'}`}
      onClick={() => onChange(reject ? 'approve' : 'reject')}
    >
      <span className="decision-knob" />
      <span className="decision-label">{reject ? 'Reject' : 'Approve'}</span>
    </button>
  );
}

// Tier-2 Journey requests (c2e_mtj_journey_app_request) waiting for me
const TIER2_TYPES = { response_time: 'Response Time', throughput: 'Throughput', technical_error: 'Technical Fails', business_error: 'Business Fails' };
const tier2Type = (t) => TIER2_TYPES[t] || t;
const TIER2_COLUMNS = [
  { key: 'app_code', label: 'App Code', filter: 'select', render: (r) => <span className="fw-semibold">{show(r.app_code)}</span> },
  { key: 'mtj_journey', label: 'MTJ Journey', className: 'wrap-cell', render: (r) => <span className="text-break">{show(r.mtj_journey)}</span> },
  { key: 'health_id', label: 'Health Check ID', render: (r) => <span className="text-nowrap fw-semibold">{show(r.health_id)}</span> },
  { key: 'service_name', label: 'Service Name', className: 'wrap-cell', render: (r) => <span className="text-break">{show(r.service_name)}</span> },
  { key: 'monitoring_type', label: 'Alert Type', filter: 'select', filterValue: (r) => tier2Type(r.monitoring_type), render: (r) => show(tier2Type(r.monitoring_type)) },
];
// Tier-2 Journey +: Kafka Name, Journey Name, Requested By and Requested On (newest request first, as the server sends them)
function Tier2Details({ row }) {
  return (
    <dl className="details-list">
      <div><dt>Request Type</dt><dd>{show(row.request_type || 'Add')}</dd></div>
      {row.request_type === 'Edit' && <div><dt>Requested Status</dt><dd>{Number(row.valid_id) === 0 ? 'Inactive' : 'Active'}</dd></div>}
      <div><dt>Kafka Name</dt><dd className="text-break">{show(row.kafka_name)}</dd></div>
      <div><dt>Journey Name</dt><dd className="text-break">{show(row.journey_name)}</dd></div>
      <div><dt>Requested By</dt><dd><PersonCell id={row.requester_by} name={row.requester_name} /></dd></div>
      <div><dt>Requested On</dt><dd className="text-nowrap">{show(row.requested_time)}</dd></div>
    </dl>
  );
}
// Tier-2 Journey and New Alert Onboarding: Reject needs Rejected Remarks
const needsRemarks = (type) => type === 'onboarding' || type === 'tier2';

const describe = (type, r) => (type === 'tier2' ? `${r.app_code || ''} – ${r.health_id || ''} (${tier2Type(r.monitoring_type) || ''})` : type === 'threshold' ? `${r.app_code} – ${r.service_name} (${typeText(r.alert_type) || ''} ${r.alert_level || ''})` : `${r.app_code || ''} – ${r.service_name || ''} (${typeText(r.alert_type)} ${r.alert_level})`);

/** CBGM My Approval: threshold changes and new alert onboarding requests waiting for the logged-in user. */
export default function MyApprovalsPage() {
  const toast = useToast();
  const { user } = useAuth();
  // Tier-2 Journey Approval tab: only for Tier-2 Checkers (config.js MTJ_Tier2_Checker)
  const isChecker = !!(user && user.tier2_checker);
  const TAB_KEYS = isChecker ? ['onboarding', 'threshold', 'tier2'] : ['onboarding', 'threshold'];
  const [data, setData] = useState({ threshold: [], onboarding: [], tier2: [] });
  const [loading, setLoading] = useState(true);
  // ?tab=onboarding | threshold | tier2 (e.g. from the pending approvals pop-up); New Alert Onboarding first otherwise
  const [params] = useSearchParams();
  const [tab, setTab] = useState(() => (TAB_KEYS.includes(params.get('tab')) ? params.get('tab') : 'onboarding'));
  useEffect(() => {
    const t = params.get('tab');
    if (TAB_KEYS.includes(t)) setTab(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  const [decisions, setDecisions] = useState({}); // { 'threshold-12': 'reject' }; missing = approve
  const [confirming, setConfirming] = useState(false); // confirm popup for Submit
  const [busy, setBusy] = useState(false);
  // New Alert Onboarding: All (default), with a threshold, or without (Configure Threshold off, consecutive_points 0)
  const [onboardView, setOnboardView] = useState('all');
  const [rejectRemarks, setRejectRemarks] = useState({}); // { 'onboarding-12': 'reason' } for rejected onboarding requests
  const [rejecting, setRejecting] = useState(null);
  const [stillPending, setStillPending] = useState(null); // after a Submit: other tabs still waiting [{ key, label, icon, count }]
  const [onboarded, setOnboarded] = useState(null); // alerts created by a CBGM Team approval (popup) // side panel: { key, row, text, error }
  const [resetKey, setResetKey] = useState(0); // Refresh redraws the table: search, column filters, sort, page and + rows back to start

  const decisionOf = (type, r) => decisions[`${type}-${r.id}`] || 'approve';
  const configured = (r) => Number(r.consecutive_points) > 0;
  const notConfiguredView = tab === 'onboarding' && onboardView === 'notConfigured';
  // Only the requests on screen are submitted (the other view's requests stay waiting)
  const rows = useMemo(
    () =>
      tab !== 'onboarding' || onboardView === 'all'
        ? data[tab]
        : data.onboarding.filter((r) => (onboardView === 'configured' ? configured(r) : !configured(r))),
    [data, tab, onboardView]
  );
  const typeLabel = tab === 'threshold' ? 'threshold change' : tab === 'tier2' ? 'Tier-2 Journey request' : 'alert onboarding request';
  const approveRows = rows.filter((r) => decisionOf(tab, r) === 'approve');
  const rejectRows = rows.filter((r) => decisionOf(tab, r) === 'reject');

  // One Submit for every request on the current tab
  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.post('/my-approvals/submit', {
        items: rows.map((r) => {
          const decision = decisionOf(tab, r);
          return { type: tab, id: r.id, decision, remarks: decision === 'reject' ? rejectRemarks[`${tab}-${r.id}`] || '' : '' };
        }),
      });
      const parts = [res.approved && `${res.approved} approved`, res.rejected && `${res.rejected} rejected`, res.alertsCreated && `${res.alertsCreated} alert${res.alertsCreated === 1 ? '' : 's'} onboarded`].filter(Boolean);
      toast('success', `${tab === 'threshold' ? 'Threshold changes' : tab === 'tier2' ? 'Tier-2 Journey requests' : 'Alert onboarding requests'}: ${parts.join(', ')}.${tab === 'tier2' ? ' The requesters have been emailed.' : ''}`);
      setConfirming(false);
      setDecisions({});
      setRejectRemarks({});
      if (res.alerts && res.alerts.length) setOnboarded(res.alerts);
      refreshPendingApprovals(); // the number on the My Approval menu items
      const fresh = await load();
      // Other tabs still waiting: a pop-up offers to open them (e.g. Update Threshold Approval after Alert Onboarding)
      const others = fresh ? tabs.filter((t) => t.key !== tab).map((t) => ({ ...t, count: (fresh[t.key] || []).length })).filter((t) => t.count > 0) : [];
      if (others.length) setStillPending(others);
    } catch (ex) {
      toast('danger', ex.message);
      setConfirming(false);
      await load();
    } finally {
      setBusy(false);
    }
  };

  // New Alert Onboarding: who is deciding, from the rows' stage ('sre' = SRE Lead, 'cbgm' = CBGM reviewer)
  const ACTOR = { sre: 'SRE Lead', cbgm: 'CBGM Team' };
  const onboardingStages = [...new Set(data.onboarding.map((r) => r.stage))].filter((st) => ACTOR[st]);
  const mixedStages = onboardingStages.length > 1;
  const actionLabel = (type) => {
    if (type !== 'onboarding' || !onboardingStages.length) return 'Action';
    return mixedStages ? 'SRE Lead / CBGM Team Action' : `${ACTOR[onboardingStages[0]]} Action`;
  };

  const actionColumn = (type) => ({
    key: 'action',
    label: actionLabel(type),
    sortable: false,
    filter: false,
    className: 'text-nowrap',
    render: (r) => {
      const key = `${type}-${r.id}`;
      const onChange = (v) => {
        // New Alert Onboarding: Reject asks for Rejected Remarks first (side panel); Approve clears them
        if (needsRemarks(type) && v === 'reject') return setRejecting({ key, type, row: r, text: rejectRemarks[key] || '', error: '' });
        setDecisions((d) => ({ ...d, [key]: v }));
        if (v === 'approve') setRejectRemarks((m) => { const n = { ...m }; delete n[key]; return n; });
      };
      return (
        <span className="d-inline-flex align-items-center gap-2">
          {/* Someone who is both SRE Lead and CBGM reviewer: show which step each row is */}
          {type === 'onboarding' && mixedStages && ACTOR[r.stage] && (
            <span className="badge text-bg-light border">{ACTOR[r.stage]}</span>
          )}
          <DecisionToggle value={decisionOf(type, r)} label={describe(type, r)} onChange={onChange} />
          {needsRemarks(type) && decisionOf(type, r) === 'reject' && (
            <button type="button" className="btn btn-sm btn-outline-secondary" title="Rejected Remarks" aria-label={`Rejected Remarks for ${describe(type, r)}`}
              onClick={() => setRejecting({ key, type, row: r, text: rejectRemarks[key] || '', error: '' })}>
              <i className="bi bi-chat-left-text" />
            </button>
          )}
        </span>
      );
    },
  });

  const load = useCallback(() => {
    setLoading(true);
    // resolves with the new lists (null when they could not be read)
    return api.get('/my-approvals')
      .then((d) => { const next = { tier2: [], ...d }; setData(next); return next; })
      .catch((e) => { toast('danger', e.message); return null; })
      .finally(() => setLoading(false));
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  // Refresh: the page as it first opened (All, every request on Approve, no search / filters), then reload
  const refresh = () => {
    setOnboardView('all');
    setDecisions({});
    setRejectRemarks({});
    setResetKey((n) => n + 1);
    load();
  };

  const tabs = [
    { key: 'onboarding', label: 'Alert Onboarding Approval', icon: 'bi-plus-circle', count: data.onboarding.length },
    { key: 'threshold', label: 'Update Threshold Approval', icon: 'bi-sliders', count: data.threshold.length },
    ...(isChecker ? [{ key: 'tier2', label: 'Tier-2 Journey Approval', icon: 'bi-signpost-split', count: data.tier2.length }] : []),
  ];

  return (
    <>
    <div className="card">
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      <DataTable
        key={`${tab}-${onboardView}-${resetKey}`}
        columns={[
          ...(tab === 'tier2' ? TIER2_COLUMNS : tab === 'threshold' ? THRESHOLD_COLUMNS : notConfiguredView ? ONBOARDING_COLUMNS.filter((c) => !NOT_CONFIGURED_HIDDEN.includes(c.key)) : ONBOARDING_COLUMNS),
          actionColumn(tab),
        ]}
        expandAll={notConfiguredView}
        rows={rows}
        renderDetails={tab === 'tier2' ? (r) => <Tier2Details row={r} /> : tab === 'threshold' ? (r) => <ThresholdDetails row={r} /> : (r) => <OnboardingDetails row={r} />}
        loading={loading}
        initialSort={{ key: 'requested_time', dir: 'desc' }}
        emptyText={
          tab === 'tier2'
            ? 'No Tier-2 Journey requests are waiting for your approval'
            : tab === 'threshold'
            ? 'No threshold changes are waiting for your approval'
            : onboardView === 'all'
              ? 'No new alert onboarding requests are waiting for your approval'
              : `No alert onboarding requests ${notConfiguredView ? 'without' : 'with'} a threshold are waiting for your approval`
        }
        toolbar={
          <>
          {tab === 'onboarding' && (
            <select
              className="form-select form-select-sm w-auto"
              aria-label="Show requests with or without a threshold"
              value={onboardView}
              onChange={(e) => { setOnboardView(e.target.value); setDecisions({}); setRejectRemarks({}); }}
            >
              <option value="all">All ({data.onboarding.length})</option>
              <option value="configured">Threshold configured ({data.onboarding.filter(configured).length})</option>
              <option value="notConfigured">Threshold not configured ({data.onboarding.filter((r) => !configured(r)).length})</option>
            </select>
          )}
          <button type="button" className="btn btn-sm btn-outline-secondary text-nowrap" onClick={refresh} disabled={loading}>
            <i className="bi bi-arrow-clockwise me-1" />Refresh
          </button>
          </>
        }
      />
      {rows.length > 0 && (
        <div className="card-footer bg-transparent d-flex flex-wrap align-items-center gap-2 py-3">
          <span className="badge text-bg-success">{approveRows.length} Approve</span>
          <span className="badge text-bg-danger">{rejectRows.length} Reject</span>
          <button type="button" className="btn btn-primary px-4 ms-auto" disabled={busy || loading} onClick={() => setConfirming(true)}>
            <i className="bi bi-send me-1" />Submit
          </button>
        </div>
      )}
    </div>

    {/* CBGM Team approval: the Criteria IDs created in alert_criteria / config_service_threshold */}
    <Modal
      show={!!onboarded}
      size="xl"
      title="Alerts onboarded successfully"
      redHeader
      onClose={() => setOnboarded(null)}
      footer={<button type="button" className="btn btn-primary" onClick={() => setOnboarded(null)}>OK</button>}
    >
      {onboarded && (
        <>
          <p className="d-flex align-items-center gap-2 mb-3">
            <i className="bi bi-check-circle-fill text-success fs-4" />
            <span>{onboarded.length} Criteria ID{onboarded.length === 1 ? ' was' : 's were'} created. The requester and SRE Lead have been emailed.</span>
          </p>
          <div className="table-responsive">
            <table className="table table-bordered table-sm align-middle mb-0 review-table">
              <thead>
                <tr><th>App Code</th><th>Service Name</th><th>Alert Type</th><th>Alert Level</th><th>Criteria ID</th></tr>
              </thead>
              <tbody>
                {onboarded.map((a) => (
                  <tr key={a.uid}>
                    <td className="text-nowrap">{a.app_code}</td>
                    <td className="text-break">{a.service_name}</td>
                    <td className="text-center text-nowrap">{typeText(a.alert_type)}</td>
                    <td className="text-center"><span className={`badge ${a.alert_level === 'FATAL' ? 'text-bg-danger' : 'text-bg-warning'}`}>{a.alert_level}</span></td>
                    <td className="text-break font-monospace small">{a.uid}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>

    {/* Reject (New Alert Onboarding): Rejected Remarks are required */}
    <Offcanvas
      show={!!rejecting}
      title="Rejected Remarks"
      onClose={() => setRejecting(null)}
      footer={
        <>
          <button type="button" className="btn btn-outline-secondary" onClick={() => setRejecting(null)}>Cancel</button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              const text = rejecting.text.trim();
              if (!text) return setRejecting((x) => ({ ...x, error: 'Rejected Remarks are required' }));
              setRejectRemarks((m) => ({ ...m, [rejecting.key]: text }));
              setDecisions((d) => ({ ...d, [rejecting.key]: 'reject' }));
              setRejecting(null);
            }}
          >
            <i className="bi bi-x-circle me-1" />Submit
          </button>
        </>
      }
    >
      {rejecting && (
        <>
          <p className="small text-body-secondary text-break">Reject <strong>{describe(rejecting.type || 'onboarding', rejecting.row)}</strong>. The requester will see these remarks.</p>
          <label className="form-label fw-semibold" htmlFor="ma-reject-remarks">Rejected Remarks <span className="text-danger">*</span></label>
          <textarea id="ma-reject-remarks" rows={5} maxLength={1000} autoFocus className={`form-control ${rejecting.error ? 'is-invalid' : ''}`} value={rejecting.text}
            onChange={(e) => setRejecting((x) => ({ ...x, text: e.target.value, error: '' }))} />
          {rejecting.error && <div className="invalid-feedback d-block">{rejecting.error}</div>}
          <div className="form-text">Cancel keeps the request on Approve (or keeps the remarks you gave before).</div>
        </>
      )}
    </Offcanvas>

    <ConfirmDialog
      size="xl"
      show={confirming}
      title="Submit decisions?"
      confirmLabel="Submit"
      cancelLabel="Back"
      busy={busy}
      onConfirm={submit}
      onClose={() => setConfirming(false)}
    >
      {confirming && (
        <>
          <p>
            Submit your decision for <strong>{rows.length}</strong> {typeLabel}{rows.length === 1 ? '' : 's'}:
          </p>
          <p className="small mb-2">
            <span className="text-success fw-semibold"><i className="bi bi-check-circle-fill me-1" />Approve {approveRows.length}</span>
            <span className="mx-2 text-body-secondary">|</span>
            <span className="text-danger fw-semibold"><i className="bi bi-x-circle-fill me-1" />Reject {rejectRows.length}</span>
          </p>
          <div className="table-responsive">
            <table className="table table-bordered table-sm align-middle small mb-3 review-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>App Code</th>
                  <th>Service</th>
                  <th>Alert Type</th>
                  {tab !== 'tier2' && <th>Alert Level</th>}{/* Tier-2 Journey requests have no alert level */}
                  <th>Requested By</th>
                  {tab === 'onboarding' && mixedStages && <th>Step</th>}
                  <th>Decision</th>
                  {rejectRows.length > 0 && <th>Rejected Remarks</th>}
                </tr>
              </thead>
              <tbody>
                {[...approveRows, ...rejectRows].map((r, i) => {
                  const approve = decisionOf(tab, r) === 'approve';
                  return (
                    <tr key={r.id}>
                      <td className="text-center">{i + 1}</td>
                      <td className="text-nowrap">{show(r.app_code)}</td>
                      <td className="text-break">{show(r.service_name)}</td>
                      <td className="text-nowrap">{show(tab === 'tier2' ? tier2Type(r.monitoring_type) : typeText(r.alert_type))}</td>
                      {tab !== 'tier2' && (
                        <td className="text-center text-nowrap">
                          {r.alert_level ? <span className={`badge ${levelBadge(r.alert_level)}`}>{r.alert_level}</span> : '—'}
                        </td>
                      )}
                      <td><PersonCell id={r.request_by} name={r.requester_name} /></td>
                      {tab === 'onboarding' && mixedStages && <td className="text-nowrap">{ACTOR[r.stage] || '—'}</td>}
                      <td className="text-center text-nowrap">
                        <span className={`badge ${approve ? 'text-bg-success' : 'text-bg-danger'}`}>
                          <i className={`bi ${approve ? 'bi-check-lg' : 'bi-x-lg'} me-1`} />{approve ? 'Approve' : 'Reject'}
                        </span>
                      </td>
                      {rejectRows.length > 0 && <td className="text-break fst-italic">{approve ? '' : rejectRemarks[`${tab}-${r.id}`] || '—'}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {tab === 'threshold' && approveRows.length > 0 && <div className="small text-body-secondary">Approved threshold changes are applied to the service thresholds straight away.</div>}
          {tab === 'tier2' && approveRows.length > 0 && <div className="small text-body-secondary">Approved requests are added to Tier-2 Journey straight away. The requesters get one email with every decision.</div>}
        </>
      )}
    </ConfirmDialog>

    {/* After a Submit: requests still waiting on the other tabs (shown once the "Alerts onboarded" pop-up is closed) */}
    <Modal
      show={!!stillPending && !onboarded}
      redHeader
      size="md"
      title="Approval pending"
      onClose={() => setStillPending(null)}
      footer={<button type="button" className="btn btn-outline-secondary" onClick={() => setStillPending(null)}>Later</button>}
    >
      {stillPending && (
        <>
          <p className="mb-3">You still have requests waiting for your approval:</p>
          <div className="list-group">
            {stillPending.map((t) => (
              <button key={t.key} type="button" className="list-group-item list-group-item-action d-flex align-items-center gap-2"
                onClick={() => { setStillPending(null); setTab(t.key); }}>
                <i className={`bi ${t.icon} text-danger`} />
                <span className="fw-semibold">{t.label}</span>
                <span className="badge rounded-pill text-bg-danger ms-auto">{t.count}</span>
                <i className="bi bi-chevron-right text-body-secondary" />
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
    </>
  );
}
