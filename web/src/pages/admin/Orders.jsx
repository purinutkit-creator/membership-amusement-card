import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { money, dt } from '../../lib/format.js';
import { PageHeader, PagedTable, usePaged, useDebounced, StatusBadge, Tabs, Chips, Modal } from '../../components/ui.jsx';
import { ReceiptPanel } from './pos/PaymentModal.jsx';

export const RANGE_OPTS = [{ value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: 'week', label: 'This week' }, { value: 'month', label: 'This month' }, { value: '', label: 'All' }];

export default function Orders() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [tab, setTab] = useState(sp.get('receipt') ? 'receipts' : 'orders');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [range, setRange] = useState('today');
  const dq = useDebounced(q);
  const orders = usePaged('/orders', { q: dq, status, range }, [], tab === 'orders');
  const receipts = usePaged('/receipts', { q: dq }, [], tab === 'receipts');
  const receiptId = sp.get('receipt');
  return (
    <div>
      <PageHeader title="Orders & Receipts" subtitle="Every POS / online order, its payment, receipts, refunds" />
      <Tabs tabs={[{ value: 'orders', label: 'Orders' }, { value: 'receipts', label: 'Receipts' }]} value={tab} onChange={setTab} />
      <div className="toolbar">
        <div className="search-box"><Search size={18} /><input className="input" placeholder={tab === 'orders' ? 'Order no. or member phone' : 'Receipt no. or order no.'} value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {tab === 'orders' && <><Chips options={RANGE_OPTS} value={range} onChange={setRange} /><select className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['PENDING_PAYMENT', 'PAID', 'REFUNDED', 'CANCELLED'].map((s) => <option key={s}>{s}</option>)}</select></>}
      </div>
      {tab === 'orders' ? <PagedTable state={orders} onRowClick={(r) => nav(`/orders/${r.id}`)} columns={[
        { label: 'Order', render: (r) => <code>{r.order_no}</code> }, { label: 'Date', render: (r) => dt(r.created_at) }, { key: 'channel', label: 'Channel' }, { key: 'staff_name', label: 'Staff' },
        { label: 'Member', render: (r) => r.member_code ? `${r.member_name} (${r.member_code})` : '' }, { key: 'payment_method', label: 'Payment' }, { label: 'Total', num: true, render: (r) => money(r.grand_total) }, { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
      ]} /> : <PagedTable state={receipts} onRowClick={(r) => setSp({ receipt: r.id })} columns={[
        { label: 'Receipt', render: (r) => <code>{r.receipt_no}</code> }, { key: 'type', label: 'Type', render: (r) => <StatusBadge status={r.type} /> }, { label: 'Date', render: (r) => dt(r.created_at) },
        { label: 'Amount', num: true, render: (r) => money(r.total ?? r.refund_amount) }, { label: 'Printed', render: (r) => `${r.print_count}× ${r.reprint_count ? `(${r.reprint_count} reprint)` : ''}` },
      ]} />}
      <Modal open={!!receiptId} title="Receipt" size="wide" onClose={() => setSp({})}>{receiptId && <ReceiptPanel receiptId={receiptId} onClose={() => setSp({})} />}</Modal>
    </div>
  );
}
