import { useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '../../lib/api.js';
import { dt } from '../../lib/format.js';
import { PageHeader, PagedTable, usePaged, useDebounced, Badge, Modal, useLoad, Chips, Kv } from '../../components/ui.jsx';
import { RANGE_OPTS } from './Orders.jsx';

export default function AuditLogs() {
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const [range, setRange] = useState('');
  const [sel, setSel] = useState(null);
  const dq = useDebounced(q);
  const actions = useLoad(() => api.get('/audit-logs/actions'), []);
  const st = usePaged('/audit-logs', { q: dq, action, range });
  return (
    <div>
      <PageHeader title="Audit Logs" subtitle="Immutable record of every important action — actor, role, target, old/new data, device, IP, reason, approver" />
      <div className="toolbar">
        <div className="search-box"><Search size={18} /><input className="input" placeholder="Target, actor or reason" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <select className="input" value={action} onChange={(e) => setAction(e.target.value)}><option value="">All actions</option>{(actions.data?.items || []).map((a) => <option key={a}>{a}</option>)}</select>
        <Chips options={RANGE_OPTS} value={range} onChange={setRange} />
      </div>
      <PagedTable state={st} onRowClick={setSel} columns={[{ label: 'Time', render: (r) => dt(r.created_at) }, { label: 'Actor', render: (r) => <>{r.actor_name}<div className="xs muted">{r.actor_type} {r.actor_role}</div></> },
        { label: 'Action', render: (r) => <Badge tone="primary">{r.action}</Badge> }, { label: 'Target', render: (r) => <>{r.target_label}<div className="xs muted">{r.target_type}</div></> }, { key: 'reason', label: 'Reason' }, { key: 'approver_name', label: 'Approver' }, { label: 'IP', render: (r) => <span className="xs mono">{r.ip}</span> }]} />
      <Modal open={!!sel} title={sel?.action} size="wide" onClose={() => setSel(null)}>
        {sel && <div className="col"><Kv items={[['Time', dt(sel.created_at)], ['Actor', `${sel.actor_name} (${sel.actor_type} ${sel.actor_role || ''})`], ['Target', `${sel.target_type} · ${sel.target_label || ''} · ${sel.target_id || ''}`], ['Reason', sel.reason], ['Approver', sel.approver_name], ['Device', sel.device_id], ['IP', sel.ip]]} />
          <div className="grid g2"><div><b>Old data</b><pre className="small card flat" style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto' }}>{JSON.stringify(sel.old_data, null, 2)}</pre></div>
            <div><b>New data</b><pre className="small card flat" style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto' }}>{JSON.stringify(sel.new_data, null, 2)}</pre></div></div></div>}
      </Modal>
    </div>
  );
}
