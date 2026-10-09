import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, Wallet, Gift, Users, CreditCard, Landmark } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useSocket } from '../../lib/realtime.js';
import { money, money0, int, dt } from '../../lib/format.js';
import { useLoad, Stat, Card, PageHeader, Chips, Skeleton, Table, Badge, ErrorState } from '../../components/ui.jsx';
import { BarsChart } from '../../components/charts.jsx';

export default function OwnerDashboard() {
  const [range, setRange] = useState('today');
  const st = useLoad(() => api.get(`/dashboard/owner?range=${range}`), [range]);
  useSocket({ 'txn:new': () => st.reload(true) });
  if (st.error) return <ErrorState error={st.error} onRetry={st.reload} />;
  const d = st.data;
  return (
    <div>
      <PageHeader title="Owner Dashboard" subtitle="All branches · liabilities · shifts" actions={<Chips options={[{ value: 'today', label: 'Today' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} value={range} onChange={setRange} />} />
      {!d ? <Skeleton rows={8} height={50} /> : <>
        <div className="grid g4">
          <Stat icon={Landmark} label="Revenue (all branches)" value={money0(d.branches.reduce((a, b) => a + Number(b.revenue), 0) + d.unbranchedRevenue)} />
          <Stat icon={Wallet} label="Wallet liability (outstanding balance)" value={money0(d.liability.totalLiability)} sub={d.liability.reconciled ? '✓ reconciles with ledger' : '⚠ ledger mismatch — investigate'} tone={d.liability.reconciled ? '' : 'danger'} />
          <Stat icon={Gift} label="Reward liability" value={`${int(d.rewardLiability.points)} pts`} sub={`${int(d.rewardLiability.stamps)} stamps · ${d.rewardLiability.pendingRedemptions.n} pending codes`} />
          <Stat icon={Users} label="Members / active cards" value={`${int(d.totals.members)} / ${int(d.totals.active_cards)}`} />
        </div>
        <div className="grid g2 mt">
          <Card title="Branches" actions={<Building2 size={18} />}>
            <Table columns={[{ key: 'name', label: 'Branch' }, { label: 'Revenue', num: true, render: (r) => money(r.revenue) }, { label: 'Top-up', num: true, render: (r) => money(r.topup) }, { label: 'Spend', num: true, render: (r) => money(r.spend) }, { key: 'plays', label: 'Plays', num: true },
              { label: 'Machines', render: (r) => `${r.machines_online}/${r.machines} online` }, { key: 'open_shifts', label: 'Open shifts', num: true }]} rows={d.branches} />
          </Card>
          <Card title="Wallet liability breakdown" actions={<Link to="/reports?key=wallet-liability" className="small">Report</Link>}>
            <div className="grid g2 mb">
              <div className="stat"><span className="label">Member cards</span><span className="value">{money0(d.liability.memberCards)}</span></div>
              <div className="stat"><span className="label">Guest cards</span><span className="value">{money0(d.liability.guestCards)}</span></div>
              <div className="stat"><span className="label">Expired cards</span><span className="value">{money0(d.liability.expired)}</span></div>
              <div className="stat"><span className="label">Blocked / lost</span><span className="value">{money0(d.liability.blocked)}</span></div>
            </div>
            <div className="small muted">Deposits held: {money(d.liability.deposits)}</div>
          </Card>
          <Card title="Machine performance"><BarsChart horizontal data={d.machinePerformance} x="name" series={[{ key: 'revenue', name: 'Revenue' }]} fmt={money0} /></Card>
          <Card title="Open cashier shifts" actions={<Link to="/shifts" className="small">Shifts</Link>}>
            <Table rowKey="shift_no" columns={[{ key: 'shift_no', label: 'Shift' }, { key: 'staff', label: 'Cashier' }, { key: 'branch', label: 'Branch' }, { label: 'Opened', render: (r) => dt(r.opened_at) }, { label: 'Opening', num: true, render: (r) => money(r.opening_cash) }]} rows={d.openShifts} />
          </Card>
        </div>
      </>}
    </div>
  );
}
