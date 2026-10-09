import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Undo2, Ban, Receipt as ReceiptIcon } from 'lucide-react';
import { api } from '../../lib/api.js';
import { money, dt, TXN_LABEL } from '../../lib/format.js';
import { Button, Card, PageHeader, useLoad, Async, StatusBadge, Table, Kv, useConfirm, useAction, Modal, Badge } from '../../components/ui.jsx';
import { ReceiptPanel } from './pos/PaymentModal.jsx';
import { useAuth } from '../../lib/auth.jsx';

export default function OrderDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const confirm = useConfirm();
  const [run] = useAction();
  const [receipt, setReceipt] = useState(null);
  const st = useLoad(() => api.get(`/orders/${id}`), [id]);
  return (
    <Async state={st}>{(o) => (
      <div>
        <PageHeader title={<span>Order <code>{o.order_no}</code></span>} subtitle={<span><StatusBadge status={o.status} /> · {o.channel} · {dt(o.created_at)} · {o.branch_name}</span>} actions={<>
          {o.status === 'PAID' && can('pos.refund') && <Button variant="danger" icon={Undo2} onClick={async () => { const reason = await confirm({ title: 'Refund order', reason: true, danger: true, message: `Refund ${money(o.grand_total)}. Top-ups are reversed from the card (balance must still be available), products restocked, a refund receipt is issued. Original transactions are kept.` }); if (reason) run(() => api.post(`/orders/${id}/refund`, { reason }), { success: 'Refunded' }).then((r) => { st.reload(); setReceipt(r.receiptId); }); }}>Refund</Button>}
          {o.status === 'PENDING_PAYMENT' && <Button icon={Ban} onClick={async () => { const reason = await confirm({ title: 'Void order', reason: true, danger: true }); if (reason) run(() => api.post(`/orders/${id}/void`, { reason }), { success: 'Voided' }).then(() => st.reload()); }}>Void</Button>}
        </>} />
        <div className="grid" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)' }}>
          <div className="col">
            <Card title="Items"><Table columns={[{ key: 'item_type', label: 'Type', render: (r) => <Badge>{r.item_type}</Badge> }, { key: 'name', label: 'Item' }, { key: 'qty', label: 'Qty', num: true }, { label: 'Unit', num: true, render: (r) => money(r.unit_price) }, { label: 'Disc.', num: true, render: (r) => (r.discount > 0 ? `-${money(r.discount)}` : '') }, { label: 'Total', num: true, render: (r) => money(r.total) }, { label: 'Bonus', num: true, render: (r) => (r.meta?.bonus ? `+${money(r.meta.bonus)}` : '') }]} rows={o.items} /></Card>
            <Card title="Ledger transactions"><Table columns={[{ label: 'Txn', render: (r) => <Link to={`/transactions/${r.id}`}><code>{r.txn_no}</code></Link> }, { label: 'Type', render: (r) => TXN_LABEL[r.type] || r.type }, { label: 'Card', render: (r) => <Link to={`/cards/${r.card_id}`} className="mono">{r.card_number}</Link> }, { label: 'Amount', num: true, render: (r) => money(Number(r.amount) + Number(r.bonus)) }, { label: 'Balance after', num: true, render: (r) => money(r.balance_after) }, { label: '', render: (r) => r.reversed_by && <Badge tone="warning">reversed</Badge> }]} rows={o.transactions} /></Card>
            <Card title="Payments"><Table columns={[{ label: 'Payment', render: (r) => <code>{r.payment_no}</code> }, { key: 'method', label: 'Method' }, { key: 'provider', label: 'Provider' }, { label: 'Amount', num: true, render: (r) => money(r.amount) }, { label: 'Received', num: true, render: (r) => money(r.received_amount) }, { label: 'Change', num: true, render: (r) => money(r.change_amount) }, { label: 'Status', render: (r) => <StatusBadge status={r.status} /> }, { label: 'Ref', render: (r) => r.provider_ref || r.meta?.reference }, { key: 'confirmed_by_name', label: 'Confirmed by' }]} rows={o.payments} /></Card>
            {o.refunds.length > 0 && <Card title="Refunds"><Table columns={[{ key: 'refund_no', label: 'Refund' }, { label: 'Amount', num: true, render: (r) => money(r.amount) }, { key: 'reason', label: 'Reason' }, { key: 'staff_name', label: 'Staff' }, { key: 'approver_name', label: 'Approver' }, { label: 'Date', render: (r) => dt(r.created_at) }]} rows={o.refunds} /></Card>}
          </div>
          <div className="col">
            <Card title="Summary"><Kv items={[['Subtotal', money(o.subtotal)], ['Manual discount', money(o.manual_discount)], ['Promotion', money(o.promo_discount)], ['Tier discount', money(o.tier_discount)], ['Service', money(o.service_amount)], [`VAT (${o.vat_mode})`, money(o.vat_amount)], ['Grand total', <b key="g">{money(o.grand_total)}</b>], ['Refunded', money(o.refunded_amount)], ['Staff', o.staff_name], ['Member', o.member_name && `${o.member_name} (${o.member_code})`], ['Note', o.note], ['Cancel reason', o.cancel_reason]]} />
              {o.promotions?.length > 0 && <div className="mt-s">{o.promotions.map((p, i) => <Badge key={i} tone="success">{p.name}</Badge>)}</div>}</Card>
            <Card title="Receipts">{o.receipts.map((r) => <div key={r.id} className="row between" style={{ padding: '6px 0' }}><span><StatusBadge status={r.type} /> <code>{r.receipt_no}</code></span><Button size="sm" icon={ReceiptIcon} onClick={() => setReceipt(r.id)}>View / print</Button></div>)}</Card>
          </div>
        </div>
        <Modal open={!!receipt} title="Receipt" size="wide" onClose={() => setReceipt(null)}>{receipt && <ReceiptPanel receiptId={receipt} onClose={() => setReceipt(null)} />}</Modal>
      </div>
    )}</Async>
  );
}
