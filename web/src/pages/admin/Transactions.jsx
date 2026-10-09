import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Download } from 'lucide-react';
import { download } from '../../lib/api.js';
import { money, dt, TXN_LABEL, signed } from '../../lib/format.js';
import { PageHeader, PagedTable, usePaged, useDebounced, Badge, Chips, Button } from '../../components/ui.jsx';
import { RANGE_OPTS } from './Orders.jsx';
import { useAuth } from '../../lib/auth.jsx';

export default function Transactions() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [range, setRange] = useState('today');
  const dq = useDebounced(q);
  const st = usePaged('/transactions', { q: dq, type, range });
  return (
    <div>
      <PageHeader title="Transactions" subtitle="Immutable ledger — every balance, point and stamp change" actions={can('report.export') && <Button icon={Download} onClick={() => download(`/reports/transactions?range=${range || 'month'}&format=xlsx`, 'transactions.xlsx')}>Export</Button>} />
      <div className="toolbar">
        <div className="search-box"><Search size={18} /><input className="input" placeholder="TXN no., card number, reference" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Chips options={RANGE_OPTS} value={range} onChange={setRange} />
        <select className="input" value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{Object.entries(TXN_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </div>
      <PagedTable state={st} onRowClick={(r) => nav(`/transactions/${r.id}`)} columns={[
        { label: 'Txn', render: (r) => <code className="xs">{r.txn_no}</code> }, { label: 'Date', render: (r) => dt(r.created_at) }, { label: 'Type', render: (r) => <Badge tone={r.reversed_by ? 'warning' : r.reversal_of ? 'info' : ''}>{TXN_LABEL[r.type] || r.type}</Badge> },
        { label: 'Card', render: (r) => <span className="mono xs">{r.card_number}</span> }, { label: 'Member', render: (r) => r.member_code }, { label: 'Amount', num: true, render: (r) => (Number(r.amount) || Number(r.bonus) ? signed(Number(r.amount) + Number(r.bonus), money) : '') },
        { label: 'Before → After', num: true, render: (r) => `${money(r.balance_before)} → ${money(r.balance_after)}` }, { label: 'Pts', num: true, render: (r) => (r.points_delta ? signed(r.points_delta) : '') }, { label: 'Stamps', num: true, render: (r) => (r.stamps_delta ? signed(r.stamps_delta) : '') },
        { label: 'By', render: (r) => <span className="xs">{r.staff_name || r.device_name || r.machine_name || ''}</span> }, { key: 'branch_name', label: 'Branch' },
      ]} />
    </div>
  );
}
