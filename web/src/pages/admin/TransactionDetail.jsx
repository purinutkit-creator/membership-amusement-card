import { useParams, Link } from 'react-router-dom';
import { Undo2, ArrowRight } from 'lucide-react';
import { api } from '../../lib/api.js';
import { money, dt, TXN_LABEL } from '../../lib/format.js';
import { Button, Card, PageHeader, useLoad, Async, Kv, Badge, useConfirm, useAction } from '../../components/ui.jsx';
import { useAuth } from '../../lib/auth.jsx';

const REFUNDABLE = ['PLAY', 'BALANCE_ADJUSTMENT', 'STAMP_ADD', 'POINT_ADD', 'STAMP_REMOVE', 'POINT_REMOVE', 'PURCHASE', 'FOOD_PURCHASE'];

export default function TransactionDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const confirm = useConfirm();
  const [run] = useAction();
  const st = useLoad(() => api.get(`/transactions/${id}`), [id]);
  return (
    <Async state={st}>{(t) => (
      <div>
        <PageHeader title={<span><code>{t.txn_no}</code></span>} subtitle={<span><Badge tone="primary">{TXN_LABEL[t.type] || t.type}</Badge> · {dt(t.created_at)} {t.reversed_by && <> · <Badge tone="warning">Reversed by {t.reversed_by_no}</Badge></>}{t.reversal_of && <> · reverses <Link to={`/transactions/${t.reversal_of}`}>{t.reversal_of_no}</Link></>}</span>}
          actions={can('transaction.refund') && !t.reversed_by && !t.reversal_of && REFUNDABLE.includes(t.type) && !(t.order_id && ['PURCHASE', 'FOOD_PURCHASE'].includes(t.type)) && <Button variant="danger" icon={Undo2} onClick={async () => { const reason = await confirm({ title: 'Refund / reverse transaction', reason: true, danger: true, message: 'A reverse entry is created; the original stays in the ledger.' }); if (reason) run(() => api.post(`/transactions/${t.id}/refund`, { reason }), { success: 'Reversed' }).then(() => st.reload()); }}>Refund / reverse</Button>} />
        <div className="card mb row wrap small" aria-label="Trace">
          <b>Trace:</b>{t.order_no && <><Link to={`/orders/${t.order_id}`}>Order {t.order_no}</Link><ArrowRight size={14} /></>}{t.payment_no && <><span>Payment {t.payment_no} ({t.payment_method}, {t.payment_status})</span><ArrowRight size={14} /></>}
          <span>{t.staff_name ? `Staff ${t.staff_name}` : t.device_name ? `Device ${t.device_name}` : 'System'}</span><ArrowRight size={14} />
          {t.member_id && <><Link to={`/members/${t.member_id}`}>Member {t.member_code}</Link><ArrowRight size={14} /></>}<Link to={`/cards/${t.card_id}`}>Card {t.card_number}</Link><ArrowRight size={14} /><span>{t.branch_name || 'No branch'}</span>
        </div>
        <div className="grid g2">
          <Card title="Wallet"><Kv items={[['Balance before', money(t.balance_before)], ['Amount', money(t.amount)], ['Bonus', money(t.bonus)], ['Balance after', <b key="a">{money(t.balance_after)}</b>], ['Points', `${t.points_before} ${t.points_delta >= 0 ? '+' : ''}${t.points_delta} = ${t.points_after}`], ['Stamps', `${t.stamps_before} ${t.stamps_delta >= 0 ? '+' : ''}${t.stamps_delta} = ${t.stamps_after}`], ['Cash movement', money(t.cash_amount)]]} /></Card>
          <Card title="Context"><Kv items={[['Card', <Link key="c" to={`/cards/${t.card_id}`} className="mono">{t.card_number}</Link>], ['Member', t.member_name && `${t.member_name} (${t.member_code}) ${t.member_phone || ''}`], ['Staff', t.staff_name && `${t.staff_name} (${t.employee_code})`], ['Approver', t.approver_name], ['Machine', t.machine_name && `${t.machine_name} (${t.machine_code})`], ['Device', t.device_name && `${t.device_name} (${t.device_code})`], ['Merchant', t.merchant_name], ['Branch', t.branch_name], ['Payment', t.payment_no && `${t.payment_no} · ${t.payment_method} · ${t.payment_status} ${t.provider_ref || ''}`], ['Redemption', t.redemption_code], ['Reference', t.reference], ['Reason', t.reason]]} /></Card>
          {t.promotions?.length > 0 && <Card title="Promotions applied">{t.promotions.map((p, i) => <div key={i}><Badge tone="success">{p.name}</Badge> <span className="small muted">{p.type} {p.saved ? `saved ${money(p.saved)}` : ''}{p.bonus ? `bonus ${money(p.bonus)}` : ''}</span></div>)}</Card>}
          {Object.keys(t.meta || {}).length > 0 && <Card title="Metadata"><pre className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(t.meta, null, 2)}</pre></Card>}
        </div>
      </div>
    )}</Async>
  );
}
