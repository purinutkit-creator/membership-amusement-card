import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Banknote, Wallet, Gamepad2, UtensilsCrossed, CreditCard, UserPlus, Users, Stamp, Coins, Gift, TrendingUp, Activity, RotateCcw } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useSocket } from '../../lib/realtime.js';
import { money, money0, int, time } from '../../lib/format.js';
import { useLoad, Stat, Card, PageHeader, Chips, Skeleton, ErrorState, Badge, Table } from '../../components/ui.jsx';
import { BarsChart, LinesChart } from '../../components/charts.jsx';
import { useAuth } from '../../lib/auth.jsx';

const RANGES = [{ value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: 'week', label: 'This week' }, { value: 'month', label: 'This month' }];

export default function Dashboard() {
  const { can, staff } = useAuth();
  const [range, setRange] = useState('today');
  const st = useLoad(() => api.get(`/dashboard?range=${range}`), [range]);
  const [feed, setFeed] = useState([]);
  useSocket({
    'txn:new': (e) => { setFeed((f) => [e, ...f].slice(0, 12)); st.reload(true); },
    'machine:update': () => st.reload(true),
    'redemption:update': () => st.reload(true),
  });
  if (st.error && !st.data) return <ErrorState error={st.error} onRetry={st.reload} />;
  const d = st.data;
  const rev = can('dashboard.revenue');
  return (
    <div>
      <PageHeader title={`Hello, ${staff?.firstName}`} subtitle="Live overview — updates in real time from the ledger" actions={<Chips options={RANGES} value={range} onChange={setRange} />} />
      {!d ? <Skeleton rows={8} height={60} /> : <>
        <div className="grid g4">
          {rev && <Stat icon={Banknote} label="Revenue (cash-in, net)" value={money0(d.kpi.revenue)} sub={`Refunds ${money0(d.kpi.refunds)}`} />}
          {rev && <Stat icon={Wallet} label="Top Up" value={money0(d.kpi.topup)} sub={`+ bonus ${money0(d.kpi.topupBonus)}`} />}
          {rev && <Stat icon={Gamepad2} label="Arcade revenue" value={money0(d.kpi.arcadeRevenue)} sub={`${int(d.kpi.plays)} plays`} />}
          {rev && <Stat icon={UtensilsCrossed} label="Food revenue" value={money0(d.kpi.foodRevenue)} />}
          <Stat icon={CreditCard} label="Active cards" value={int(d.kpi.activeCards)} sub={`${int(d.kpi.activeCardsTotal)} active in total`} />
          <Stat icon={UserPlus} label="New members" value={int(d.kpi.newMembers)} />
          <Stat icon={Users} label="Active members" value={int(d.kpi.activeMembers)} sub={`${int(d.kpi.activeMembers30d)} in last 30 days`} />
          <Stat icon={Activity} label="Plays" value={int(d.kpi.plays)} />
          <Stat icon={Stamp} label="Stamps issued" value={int(d.kpi.stampsIssued)} />
          <Stat icon={Coins} label="Points issued" value={int(d.kpi.pointsIssued)} />
          <Stat icon={Gift} label="Rewards redeemed" value={int(d.kpi.rewardsRedeemed)} />
          {rev && <Stat icon={TrendingUp} label="Average spend / visitor" value={money(d.kpi.averageSpend)} sub={`Wallet liability ${money0(d.kpi.walletLiability)}`} />}
        </div>
        <div className="grid g2 mt">
          {rev && <Card title="Revenue by hour"><BarsChart data={d.charts.byHour.map((h) => ({ ...h, hour: `${String(h.hour).padStart(2, '0')}:00` }))} x="hour" series={[{ key: 'amount', name: 'Revenue' }]} fmt={money0} /></Card>}
          {rev && <Card title="Revenue & top-up — last 14 days"><LinesChart data={d.charts.byDay.map((x) => ({ ...x, day: x.day.slice(5) }))} x="day" series={[{ key: 'revenue', name: 'Revenue' }, { key: 'topup', name: 'Top-up' }]} fmt={money0} /></Card>}
          <Card title="Plays — last 14 days"><BarsChart data={d.charts.byDay.map((x) => ({ ...x, day: x.day.slice(5) }))} x="day" series={[{ key: 'plays', name: 'Plays' }]} fmt={int} /></Card>
          <Card title="Top machines" actions={<Link to="/machines" className="small">All machines</Link>}><BarsChart horizontal data={d.charts.topMachines} x="name" series={[{ key: rev ? 'revenue' : 'plays', name: rev ? 'Revenue' : 'Plays' }]} fmt={rev ? money0 : int} /></Card>
          <Card title="Tier distribution"><BarsChart horizontal data={d.charts.tiers} x="name" series={[{ key: 'members', name: 'Members' }]} fmt={int} /></Card>
          {rev && <Card title="Payment methods"><BarsChart horizontal data={d.charts.methods} x="method" series={[{ key: 'amount', name: 'Amount' }]} fmt={money0} /></Card>}
          <Card title="Top packages"><Table rowKey="name" columns={[{ key: 'name', label: 'Package' }, { key: 'count', label: 'Sold', num: true }, { label: 'Amount', num: true, render: (r) => money(r.amount) }]} rows={d.charts.topPackages} /></Card>
          <Card title="Top promotions"><Table rowKey="name" columns={[{ key: 'name', label: 'Promotion' }, { key: 'uses', label: 'Uses', num: true }, { label: 'Benefit', num: true, render: (r) => money(r.benefit) }]} rows={d.charts.topPromotions} /></Card>
          <Card title="Machines"><div className="row wrap"><Badge tone="success">{d.machines.online} online</Badge><Badge>{d.machines.total - d.machines.online} offline</Badge><Badge tone="warning">{d.machines.maintenance} maintenance</Badge><Badge tone="danger">{d.machines.down} error / disabled</Badge></div></Card>
          <Card title="Live activity" actions={<RotateCcw size={16} className="faint" />}>
            {feed.length === 0 ? <div className="muted small">Waiting for activity… (taps, payments, top-ups appear here instantly)</div> : feed.map((e, i) => (
              <div key={i} className="row between small" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}><Badge tone={e.type === 'REFUND' ? 'danger' : e.type === 'PLAY' ? 'info' : 'success'}>{e.type}</Badge><span className="grow mono">{e.txnNo || e.orderNo}</span>{rev && <b className="num">{money(e.amount)}</b>}<span className="faint">{time(e.at)}</span></div>))}
          </Card>
        </div>
      </>}
    </div>
  );
}
