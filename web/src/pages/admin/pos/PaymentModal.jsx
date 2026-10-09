import { useEffect, useRef, useState } from 'react';
import { Banknote, QrCode, Landmark, CreditCard, Wallet, Smartphone, Globe, CheckCircle2, Printer, Mail, ShieldAlert, FlaskConical } from 'lucide-react';
import { api } from '../../../lib/api.js';
import { money } from '../../../lib/format.js';
import { useSocket, useWatch } from '../../../lib/realtime.js';
import { Button, Modal, Input, useAction, useLoad, useToast, Spinner } from '../../../components/ui.jsx';
import { QR, ReceiptView, CardScanInput } from '../../../components/domain.jsx';
import { PrinterManager, getDefaultPrinter } from '../../../lib/printer.js';
import { play } from '../../../lib/sound.js';
import { useAuth } from '../../../lib/auth.jsx';

const ICONS = { CASH: Banknote, PROMPTPAY: QrCode, BANK_TRANSFER: Landmark, CREDIT_CARD: CreditCard, DEBIT_CARD: CreditCard, E_WALLET: Smartphone, GATEWAY: Globe, CARD_BALANCE: Wallet, OTHER: Wallet };

function Countdown({ until }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.floor((new Date(until) - now) / 1000));
  return <span className="mono">{String(Math.floor(s / 60)).padStart(2, '0')}:{String(s % 60).padStart(2, '0')}</span>;
}

export function ReceiptPanel({ receiptId, onClose }) {
  const { settings, can } = useAuth();
  const st = useLoad(() => api.get(`/receipts/${receiptId}`), [receiptId]);
  const rs = { data: settings?.receipt || {} };
  const [run, busy] = useAction();
  const [email, setEmail] = useState('');
  const toast = useToast();
  const doPrint = async (reprint = false) => {
    const rc = await run(() => api.post(`/receipts/${receiptId}/print`, { reprint }));
    const printer = await getDefaultPrinter('RECEIPT');
    try {
      await PrinterManager.printReceipt(printer, st.data.data, { reprint: rc.isReprint, settings: rs.data || {}, copies: rs.data?.copies, openDrawer: !rc.isReprint });
      if (printer && printer.connection !== 'BROWSER') toast.success(`Printed on ${printer.name}`);
    } catch (e) { toast.error(e.message); }
  };
  useEffect(() => { if (st.data && rs.data?.autoPrint && st.data.print_count === 0) doPrint(false); }, [st.data, rs.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!st.data) return <Spinner />;
  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) auto', gap: 20 }}>
      <div className="col">
        <div className="alert success"><CheckCircle2 /> <div><b>Completed.</b> Receipt {st.data.receipt_no}</div></div>
        <Button variant="primary" size="lg" icon={Printer} loading={busy} onClick={() => doPrint(false)}>Print receipt</Button>
        {can('pos.reprint') && st.data.print_count > 0 && <Button icon={Printer} onClick={() => doPrint(true)}>Reprint</Button>}
        <div className="row"><Input className="grow" placeholder="customer@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button icon={Mail} disabled={!email} onClick={() => run(() => api.post(`/receipts/${receiptId}/email`, { email }), { success: 'Receipt emailed' })}>Email</Button></div>
        <div className="small muted">Digital receipt: <a href={st.data.publicUrl} target="_blank" rel="noreferrer">{st.data.publicUrl}</a></div>
        <Button size="lg" onClick={onClose}>New transaction</Button>
      </div>
      <div style={{ maxHeight: '60vh', overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
        <ReceiptView data={st.data.data} width={rs.data?.paperWidth || '80'} logoUrl={settings?.branding?.logoMediaId && rs.data?.showLogo !== false ? `/api/public/media/${settings.branding.logoMediaId}` : null} />
      </div>
    </div>
  );
}

/**
 * Pays an existing order. onComplete(result) when paid; display(state) pushes to the customer display.
 */
export default function PaymentModal({ order, onClose, onComplete, display }) {
  const methods = useLoad(() => api.get('/payment-methods'), []);
  const [method, setMethod] = useState(null);
  const [received, setReceived] = useState('');
  const [reference, setReference] = useState('');
  const [payment, setPayment] = useState(null);
  const [done, setDone] = useState(null);
  const [run, busy] = useAction();
  const { can } = useAuth();
  const total = Number(order.grand_total);
  useWatch(`order:${order.id}`);
  useSocket({
    'payment:update': (e) => {
      if (e.orderId !== order.id) return;
      if (e.status === 'PAID' && e.completed) finish({ receipt: { id: e.receiptId }, payment: { method: e.method } });
      else if (['FAILED', 'CANCELLED'].includes(e.status) && payment?.id === e.paymentId) setPayment((p) => ({ ...p, status: e.status }));
    },
  }, { kind: 'staff' }, [order.id, payment?.id]);

  useEffect(() => { display?.({ screen: 'ORDER', total }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const finished = useRef(false);
  const finish = (r) => {
    if (finished.current) return;
    finished.current = true;
    play('paymentSuccess');
    setDone(r);
    display?.({ screen: 'SUCCESS', total, method: r.payment?.method });
    onComplete?.(r);
  };

  const pay = async (m, extra = {}) => {
    const r = await run(() => api.post(`/orders/${order.id}/pay`, { method: m, idempotencyKey: `${order.id}:${m}:${Date.now()}`, ...extra }));
    if (r.completed) finish(r);
    else {
      setPayment(r.payment);
      if (m === 'PROMPTPAY' || m === 'GATEWAY') display?.({ screen: 'PAYMENT', total, qr: r.payment.qr_payload, expiresAt: r.payment.expires_at, method: m });
    }
  };
  const quick = [total, 100, 500, 1000].filter((v, i, a) => (i === 0 || v > total) && a.indexOf(v) === i);
  const enabled = (methods.data?.items || []).filter((x) => x.enabled);
  const change = Number(received || 0) - total;

  return (
    <Modal open title={done ? 'Payment complete' : `Payment — ${order.order_no}`} onClose={() => { if (!busy) onClose(!!done); }} size="wide">
      {done ? <ReceiptPanel receiptId={done.receipt?.id} onClose={() => onClose(true)} /> : (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 260px) 1fr', gap: 18 }}>
          <div className="col">
            <div className="card flat center"><div className="muted small">Amount due</div><div className="huge num">{money(total)}</div></div>
            {enabled.map((pm) => { const I = ICONS[pm.code] || Wallet; return <Button key={pm.code} size="lg" variant={method === pm.code ? 'primary' : ''} icon={I} onClick={() => { setMethod(pm.code); setPayment(null); }} disabled={!!payment && payment.status === 'PENDING'}>{pm.name}</Button>; })}
          </div>
          <div className="col">
            {!method && <div className="empty">Choose a payment method</div>}
            {method === 'CASH' && <>
              <div className="chips">{quick.map((q, i) => <button key={q} type="button" className="chip" style={{ minHeight: 52, fontSize: '1.1rem' }} onClick={() => setReceived(String(q))}>{i === 0 ? `Exact ${money(q)}` : money(q)}</button>)}</div>
              <Input label="Cash received" size="xl" type="number" inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} autoFocus />
              <div className="row between big"><span>Change</span><span className={`num ${change < 0 ? 'danger' : 'success'}`}>{received ? money(Math.max(0, change)) : '—'}</span></div>
              <Button variant="success" size="xl" loading={busy} disabled={!received || change < 0} onClick={() => pay('CASH', { receivedAmount: Number(received) })}>Confirm cash payment</Button>
            </>}
            {(method === 'PROMPTPAY' || method === 'GATEWAY') && (!payment ? <Button variant="primary" size="xl" loading={busy} icon={QrCode} onClick={() => pay(method)}>Generate {method === 'PROMPTPAY' ? 'PromptPay' : 'payment'} QR for {money(total)}</Button> : (
              <div className="col center" style={{ alignItems: 'center' }}>
                {payment.status === 'PENDING' ? <>
                  {payment.qr_payload && <QR value={payment.qr_payload} size={240} />}
                  {payment.meta?.redirectUrl && <a href={payment.meta.redirectUrl} target="_blank" rel="noreferrer">Open payment page</a>}
                  <div className="big num">{money(total)}</div>
                  {payment.expires_at && <div className="muted">Expires in <Countdown until={payment.expires_at} /></div>}
                  <div className="row"><Spinner /> Waiting for payment… (shown on customer display)</div>
                  {method === 'PROMPTPAY' && can('payment.confirm') && <><Input placeholder="Slip / reference (optional)" value={reference} onChange={(e) => setReference(e.target.value)} />
                    <Button variant="success" size="lg" loading={busy} icon={CheckCircle2} onClick={() => run(() => api.post(`/payments/${payment.id}/confirm`, { reference })).then(finish)}>Payment received — confirm</Button>
                    <div className="xs faint">Confirm only after verifying the incoming transfer in your banking app.</div></>}
                  {method === 'GATEWAY' && payment.provider === 'mock' && <Button icon={FlaskConical} onClick={() => run(() => api.post(`/payments/${payment.id}/simulate`))}>TEST MODE: simulate gateway webhook</Button>}
                  <Button variant="ghost" onClick={() => run(() => api.post(`/payments/${payment.id}/cancel`)).then(() => { setPayment(null); display?.({ screen: 'ORDER', total }); })}>Cancel QR</Button>
                </> : <div className="alert danger"><ShieldAlert /> Payment {payment.status}. Choose another method.</div>}
              </div>
            ))}
            {method === 'BANK_TRANSFER' && (!payment ? <Button variant="primary" size="xl" loading={busy} onClick={() => pay('BANK_TRANSFER')}>Start bank transfer</Button> : <>
              <div className="card flat"><div className="kv"><div>Bank</div><div>{payment.meta?.bank?.bank || '—'}</div><div>Account name</div><div>{payment.meta?.bank?.accountName || '—'}</div><div>Account no.</div><div className="mono">{payment.meta?.bank?.accountNumber || '—'}</div></div>
                {payment.meta?.bank?.instruction && <p className="small">{payment.meta.bank.instruction}</p>}</div>
              <Input label="Transfer reference / slip no." value={reference} onChange={(e) => setReference(e.target.value)} />
              {can('payment.confirm') && <Button variant="success" size="lg" loading={busy} onClick={() => run(() => api.post(`/payments/${payment.id}/confirm`, { reference })).then(finish)}>Transfer verified — confirm</Button>}
            </>)}
            {['CREDIT_CARD', 'DEBIT_CARD', 'E_WALLET', 'OTHER'].includes(method) && <>
              <div className="alert">Process {money(total)} on the external terminal / wallet app, then enter its approval code. Card numbers are never entered or stored here.</div>
              <Input label="Approval / reference code *" value={reference} onChange={(e) => setReference(e.target.value)} autoFocus />
              <Button variant="success" size="xl" loading={busy} disabled={!reference} onClick={() => pay(method, { reference })}>Confirm payment</Button>
            </>}
            {method === 'CARD_BALANCE' && <>
              <div className="alert">Tap / scan the customer's card to pay {money(total)} from its balance.</div>
              <CardScanInput onCard={(c) => pay('CARD_BALANCE', { cardIdentifier: c.cardNumber })} />
            </>}
          </div>
        </div>
      )}
    </Modal>
  );
}
