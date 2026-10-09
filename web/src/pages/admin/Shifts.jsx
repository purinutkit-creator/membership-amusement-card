import { useState } from 'react';
import { money, dt } from '../../lib/format.js';
import { api } from '../../lib/api.js';
import { PageHeader, PagedTable, usePaged, StatusBadge, Modal, useLoad, Kv, Table, Card } from '../../components/ui.jsx';

export default function Shifts() {
  const [sel, setSel] = useState(null);
  const st = usePaged('/shifts', {});
  const d = useLoad(() => (sel ? api.get(`/shifts/${sel}`) : Promise.resolve(null)), [sel]);
  return (
    <div>
      <PageHeader title="Cashier Shifts" subtitle="Opening cash · cash in/out · expected vs actual · over/short" />
      <PagedTable state={st} onRowClick={(r) => setSel(r.id)} columns={[{ label: 'Shift', render: (r) => <code>{r.shift_no}</code> }, { key: 'staff_name', label: 'Cashier' }, { key: 'branch_name', label: 'Branch' }, { label: 'Opened', render: (r) => dt(r.opened_at) }, { label: 'Closed', render: (r) => dt(r.closed_at) },
        { label: 'Opening', num: true, render: (r) => money(r.opening_cash) }, { label: 'Expected', num: true, render: (r) => money(r.expected_cash) }, { label: 'Actual', num: true, render: (r) => money(r.actual_cash) },
        { label: 'Over/Short', num: true, render: (r) => r.over_short != null && <span className={r.over_short < 0 ? 'danger' : r.over_short > 0 ? 'warning' : 'success'}>{money(r.over_short)}</span> }, { label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]} />
      <Modal open={!!sel} title="Shift report" size="wide" onClose={() => setSel(null)}>
        {d.data && <div className="col">
          <Kv items={[['Shift', d.data.shift.shift_no], ['Cashier', `${d.data.shift.first_name} ${d.data.shift.last_name}`], ['Opened', dt(d.data.shift.opened_at)], ['Closed', dt(d.data.shift.closed_at)], ['Opening cash', money(d.data.cash.opening)], ['Cash sales', money(d.data.cash.sales)], ['Cash refunds', money(d.data.cash.refunds)], ['Cash in', money(d.data.cash.cashIn)], ['Cash out', money(d.data.cash.cashOut)], ['Expected cash', money(d.data.cash.expected)], ['Actual cash', money(d.data.shift.actual_cash)], ['Over / short', money(d.data.shift.over_short)], ['Orders paid / voided', `${d.data.orders.paid} / ${d.data.orders.voided}`], ['Top-ups', `${d.data.topups.count} · ${money(d.data.topups.amount)} (+${money(d.data.topups.bonus)} bonus)`]]} />
          <Card title="By payment method"><Table rowKey="method" columns={[{ key: 'method', label: 'Method' }, { key: 'count', label: 'Count', num: true }, { label: 'Amount', num: true, render: (r) => money(r.amount) }]} rows={d.data.byMethod} /></Card>
          <Card title="Cash movements"><Table columns={[{ key: 'type', label: 'Type' }, { label: 'Amount', num: true, render: (r) => money(r.amount) }, { key: 'reason', label: 'Reason' }, { key: 'first_name', label: 'Staff' }, { label: 'Time', render: (r) => dt(r.created_at) }]} rows={d.data.movements} /></Card>
        </div>}
      </Modal>
    </div>
  );
}
