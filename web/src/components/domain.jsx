import { useEffect, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
import QRCodeLib from 'qrcode';
import jsQR from 'jsqr';
import { Camera, CreditCard, ScanLine, X, Upload, Image as ImageIcon, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api.js';
import { useKeyboardWedge, useCardReads, ReaderManager } from '../lib/readers.js';
import { Button, Modal, Input, Field, useLoad, Empty, Spinner, Badge } from './ui.jsx';
import { money, dt, maskCard } from '../lib/format.js';
import { play } from '../lib/sound.js';

// ---------------------------------------------------------------- barcode & QR
export function Barcode({ value, height = 50, width = 2, displayValue = true, className }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current && value) { try { JsBarcode(ref.current, value, { format: 'CODE128', height, width, displayValue, margin: 4, fontSize: 14, background: '#ffffff' }); } catch { /* invalid */ } } }, [value, height, width, displayValue]);
  return <svg ref={ref} className={className} role="img" aria-label={`Barcode ${value}`} />;
}
export function QR({ value, size = 160, className }) {
  const [src, setSrc] = useState(null);
  useEffect(() => { if (value) QRCodeLib.toDataURL(value, { width: size * 2, margin: 1, errorCorrectionLevel: 'M' }).then(setSrc).catch(() => setSrc(null)); }, [value, size]);
  return src ? <img src={src} width={size} height={size} alt="QR code" className={className} style={{ imageRendering: 'pixelated', background: '#fff', borderRadius: 8 }} /> : <div style={{ width: size, height: size }} className="skeleton" />;
}

// ---------------------------------------------------------------- camera scanning
/** Camera barcode / QR scanner: BarcodeDetector (native) with jsQR fallback for QR. */
export function CameraScanner({ open, onClose, onResult, title = 'Scan barcode / QR' }) {
  const video = useRef(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
    let stream; let raf; let stopped = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'ean_13', 'code_39', 'itf'] }) : null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.current.srcObject = stream;
        await video.current.play();
        const tick = async () => {
          if (stopped) return;
          const v = video.current;
          if (v && v.readyState >= 2) {
            let val = null;
            if (detector) { const codes = await detector.detect(v).catch(() => []); val = codes[0]?.rawValue; }
            if (!val) {
              canvas.width = v.videoWidth; canvas.height = v.videoHeight; ctx.drawImage(v, 0, 0);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              val = jsQR(img.data, img.width, img.height)?.data;
            }
            if (val) { play('tap'); onResult(val); return; }
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) { setErr(e.name === 'NotAllowedError' ? 'Camera permission denied' : 'Camera not available'); }
    })();
    return () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  }, [open, onResult]);
  return (
    <Modal open={open} title={title} onClose={onClose}>
      {err ? <div className="alert danger">{err}</div> : <video ref={video} playsInline muted style={{ width: '100%', borderRadius: 12, background: '#000' }} />}
      <p className="small muted mt-s">Hold the barcode / QR code inside the frame. {!('BarcodeDetector' in window) && 'This browser supports QR via camera; for 1D barcodes use a USB scanner.'}</p>
    </Modal>
  );
}

// ---------------------------------------------------------------- card identification
/**
 * Identify a card by any method: type 12 digits, USB/RFID keyboard-wedge reader, barcode scanner,
 * NFC/serial/HID/BLE reader (via ReaderManager), or camera QR/barcode.
 * onCard(cardView) is called after the server resolves it.
 */
export function CardScanInput({ onCard, onError, autoFocus = true, placeholder = 'Tap / scan card or type 12-digit number', lookup = '/cards/lookup', size = 'lg', disabled, wedge = true }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [cam, setCam] = useState(false);
  const [err, setErr] = useState(null);
  const inputRef = useRef(null);
  const resolve = async (ident) => {
    const v = String(ident || '').trim();
    if (!v || busy) return;
    setBusy(true); setErr(null);
    try {
      const card = await api.get(`${lookup}?identifier=${encodeURIComponent(v)}`);
      play('tap');
      setValue('');
      onCard(card, v);
    } catch (e) { setErr(e.message); play('error'); onError?.(e); } finally { setBusy(false); setTimeout(() => inputRef.current?.focus(), 30); }
  };
  useKeyboardWedge(resolve, { enabled: !disabled && wedge });
  useCardReads(resolve, !disabled && wedge);
  return (
    <div className="col gap-s">
      <form className="row" onSubmit={(e) => { e.preventDefault(); resolve(value); }}>
        <div className="grow" style={{ position: 'relative' }}>
          <CreditCard size={20} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
          <input ref={inputRef} className={`input ${size}`} style={{ paddingLeft: 44 }} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} disabled={disabled} inputMode="text" autoComplete="off" aria-label="Card identifier" />
        </div>
        <Button type="submit" variant="primary" size={size} icon={ScanLine} loading={busy} disabled={disabled}>Find</Button>
        <Button size={size} icon={Camera} onClick={() => setCam(true)} aria-label="Scan with camera" disabled={disabled} />
      </form>
      {err && <div className="alert danger">{err}</div>}
      <div className="xs faint">Reader: {ReaderManager.status().label} · {ReaderManager.status().status}</div>
      <CameraScanner open={cam} onClose={() => setCam(false)} onResult={(v) => { setCam(false); resolve(v); }} />
    </div>
  );
}

export function CardChip({ card, onClear }) {
  if (!card) return null;
  return (
    <div className="card tight row between" style={{ borderColor: 'var(--primary)' }}>
      <div className="row">
        <CreditCard color="var(--primary)" />
        <div><div className="mono bold">{card.cardNumber}</div>
          <div className="xs muted">{card.cardType} · {card.member ? `${card.member.name} (${card.member.memberCode})` : 'Guest'} · <Badge tone={card.status === 'ACTIVE' ? 'success' : 'danger'}>{card.status}</Badge></div></div>
      </div>
      <div className="row"><div className="right"><div className="bold num">{money(card.balance)}</div><div className="xs muted">{card.points} pts · {card.stamps} stamps</div></div>
        {onClear && <Button variant="ghost" size="sm" icon={X} onClick={onClear} aria-label="Clear card" />}</div>
    </div>
  );
}

// ---------------------------------------------------------------- manager approval
export function ApprovalModal({ request, onDone }) {
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  useEffect(() => { setCode(''); setPin(''); }, [request]);
  if (!request) return null;
  return (
    <Modal open title="Manager approval required" onClose={() => onDone(null)}
      footer={<><Button onClick={() => onDone(null)}>Cancel</Button><Button variant="primary" icon={ShieldCheck} disabled={!code || pin.length < 4} onClick={() => onDone({ employeeCode: code.trim(), pin })}>Approve</Button></>}>
      <form className="col" onSubmit={(e) => { e.preventDefault(); if (code && pin.length >= 4) onDone({ employeeCode: code.trim(), pin }); }}>
        <div className="alert warning">{request.message}</div>
        <Input label="Approver employee code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoFocus />
        <Input label="Approver PIN" type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- receipt
export function ReceiptView({ data, width = '80', reprint, showReprintLabel = true, id = 'receipt-print', logoUrl }) {
  if (!data) return null;
  const r = data;
  const publicUrl = `${location.origin}/r/${r.qrToken}`;
  return (
    <div id={id} className={`receipt w${width}`} translate="no">
      <div className="rc-center">
        {logoUrl && <img src={logoUrl} alt="" style={{ maxHeight: 50, maxWidth: '70%' }} />}
        <div className="rc-big">{r.store?.name}</div>
        {r.branch?.name && <div>{r.branch.name}</div>}
        {r.store?.address && <div>{r.store.address}</div>}
        {r.store?.phone && <div>Tel {r.store.phone}</div>}
        {r.store?.taxId && <div>TAX ID {r.store.taxId}</div>}
        {r.header && <div>{r.header}</div>}
        {reprint && showReprintLabel && <div className="bold">*** REPRINT ***</div>}
        {r.type === 'REFUND' && <div className="bold">*** REFUND RECEIPT / ใบคืนเงิน ***</div>}
      </div>
      <hr />
      <div className="rc-row"><span>Receipt</span><span>{r.receiptNo}</span></div>
      <div className="rc-row"><span>Date</span><span>{new Date(r.createdAt).toLocaleString('en-GB')}</span></div>
      {r.orderNo && <div className="rc-row"><span>Order</span><span>{r.orderNo}</span></div>}
      {r.transactionNos?.length > 0 && <div className="rc-row"><span>Txn</span><span>{r.transactionNos.slice(-1)[0]}</span></div>}
      {r.cashier && <div className="rc-row"><span>Cashier</span><span>{r.cashier}</span></div>}
      {r.member && <div className="rc-row"><span>Member</span><span>{r.member.code} · {r.member.phone}</span></div>}
      <hr />
      {r.items?.map((i, k) => (
        <div key={k} style={{ marginBottom: 3 }}>
          <div>{i.name}{i.card ? ` (${i.card})` : ''}</div>
          <div className="rc-row"><span>&nbsp;&nbsp;{i.qty} × {money(i.unitPrice, '')}</span><span>{money(i.total, '')}</span></div>
          {i.discount > 0 && <div className="rc-row"><span>&nbsp;&nbsp;Discount</span><span>-{money(i.discount, '')}</span></div>}
          {i.bonus > 0 && <div className="rc-row"><span>&nbsp;&nbsp;Bonus credit</span><span>+{money(i.bonus, '')}</span></div>}
        </div>
      ))}
      {r.totals && <>
        <hr />
        <div className="rc-row"><span>Subtotal</span><span>{money(r.totals.subtotal, '')}</span></div>
        {r.totals.discount > 0 && <div className="rc-row"><span>Discount</span><span>-{money(r.totals.discount, '')}</span></div>}
        {r.totals.service > 0 && <div className="rc-row"><span>Service charge</span><span>{money(r.totals.service, '')}</span></div>}
        {r.totals.vat > 0 && <div className="rc-row"><span>VAT {r.totals.vatRate}% {r.totals.vatMode === 'INCLUSIVE' ? '(incl.)' : ''}</span><span>{money(r.totals.vat, '')}</span></div>}
        <div className="rc-row rc-big"><span>TOTAL</span><span>{money(r.totals.grandTotal)}</span></div>
      </>}
      {r.refundAmount != null && <><hr /><div className="rc-row rc-big"><span>REFUND</span><span>{money(r.refundAmount)}</span></div><div>Reason: {r.refundReason}</div>{r.originalTxnNo && <div>Original: {r.originalTxnNo}</div>}</>}
      {r.payment && <>
        <div className="rc-row"><span>Paid ({r.payment.method})</span><span>{money(r.payment.amount, '')}</span></div>
        {r.payment.received != null && <div className="rc-row"><span>Received</span><span>{money(r.payment.received, '')}</span></div>}
        {r.payment.change != null && <div className="rc-row"><span>Change</span><span>{money(r.payment.change, '')}</span></div>}
        {r.payment.ref && <div className="rc-row"><span>Ref</span><span>{r.payment.ref}</span></div>}
      </>}
      {(r.cards?.length > 0 || r.pointsEarned > 0 || r.stampsEarned > 0) && <hr />}
      {r.cards?.map((c, k) => <div key={k} className="rc-row"><span>Card {c.number}</span><span>Bal {money(c.newBalance)}</span></div>)}
      {r.pointsEarned > 0 && <div className="rc-row"><span>Points earned</span><span>+{r.pointsEarned}</span></div>}
      {r.stampsEarned > 0 && <div className="rc-row"><span>Stamps earned</span><span>+{r.stampsEarned}</span></div>}
      {r.promotions?.length > 0 && <div>{r.promotions.map((p, k) => <div key={k}>★ {p.name}</div>)}</div>}
      <hr />
      <div className="rc-center">
        {r.qrToken && <><QR value={publicUrl} size={110} /><div className="xs">Digital receipt</div></>}
        {r.showBarcode && <Barcode value={r.receiptNo} height={36} width={1.4} />}
        {r.footer && <div>{r.footer}</div>}
        <div className="bold">{r.thankYou || 'Thank you!'}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- media
export const mediaSrc = (id) => (id ? `/api/public/media/${id}` : null);
export function useMediaUrl(id) { return mediaSrc(id); }

export function MediaPicker({ open, onClose, onPick, kind = 'IMAGE', category = 'GENERAL', title = 'Media Library' }) {
  const st = useLoad(() => (open ? api.get(`/media?kind=${kind}&pageSize=120`) : Promise.resolve(null)), [open, kind]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const upload = async (files) => {
    if (!files?.length) return;
    setUploading(true);
    const fd = new FormData();
    fd.append('category', category);
    for (const f of files) fd.append('files', f);
    try { const r = await api.upload('/media', fd); await st.reload(); if (r.items.length === 1) onPick(r.items[0]); } finally { setUploading(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={title} size="wide">
      <div className="card flat center" style={{ borderStyle: 'dashed', padding: 24 }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files); }}>
        <Upload /><div>Drag & drop files here, or</div>
        <Button icon={Upload} loading={uploading} onClick={() => fileRef.current.click()}>Choose files</Button>
        <input ref={fileRef} type="file" hidden multiple accept={kind === 'FONT' ? '.ttf,.otf,.woff,.woff2' : kind === 'SOUND' ? 'audio/*' : kind === 'VIDEO' ? 'video/*' : 'image/*'} onChange={(e) => upload(e.target.files)} />
      </div>
      <div className="auto-grid mt">
        {st.loading ? <Spinner /> : !st.data?.items.length ? <Empty title="No files yet" /> : st.data.items.map((m) => (
          <button key={m.id} type="button" className="tile" onClick={() => onPick(m)} style={{ minHeight: 140 }}>
            {m.kind === 'IMAGE' ? <img src={m.url} alt="" style={{ width: '100%', height: 90, objectFit: 'contain' }} /> : <ImageIcon />}
            <div className="xs">{m.original_name}</div>
            {m.status !== 'APPROVED' && <Badge tone="warning">{m.status}</Badge>}
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function MediaField({ label, value, onChange, kind = 'IMAGE', category }) {
  const [open, setOpen] = useState(false);
  const url = useMediaUrl(value);
  return (
    <Field label={label}>
      <div className="row">
        {value && kind === 'IMAGE' && url && <img src={url} alt="" style={{ height: 48, maxWidth: 120, objectFit: 'contain', borderRadius: 8, border: '1px solid var(--border)' }} />}
        {value && kind !== 'IMAGE' && <Badge tone="info">Selected</Badge>}
        <Button size="sm" icon={Upload} onClick={() => setOpen(true)}>{value ? 'Change' : 'Choose'}</Button>
        {value && <Button size="sm" variant="ghost" onClick={() => onChange(null)}>Remove</Button>}
      </div>
      <MediaPicker open={open} kind={kind} category={category} onClose={() => setOpen(false)} onPick={(m) => { onChange(m.id, m); setOpen(false); }} />
    </Field>
  );
}

// ---------------------------------------------------------------- digital card
export function DigitalCard({ card, member, tier, storeName, showCodes = true }) {
  const theme = tier?.card_theme || {};
  return (
    <div className="col">
      <div className="dcard" style={{ '--c1': theme.c1 || tier?.color || '#6D28D9', '--c2': theme.c2 || '#0EA5E9' }}>
        <div className="row between" style={{ zIndex: 1 }}><b>{storeName}</b>{tier && <span className="badge" style={{ background: 'rgba(255,255,255,.25)', color: '#fff' }}>{tier.name}</span>}</div>
        <div style={{ zIndex: 1 }}><div className="xs" style={{ opacity: .8 }}>Balance</div><div className="bal">{money(card.balance)}</div></div>
        <div className="row between" style={{ zIndex: 1 }}><div><div className="num">{card.cardNumber?.replace(/(\d{4})(?=\d)/g, '$1 ')}</div><div className="xs">{member}</div></div>
          <div className="right xs">{card.points} pts<br />{card.stamps} stamps</div></div>
      </div>
      {showCodes && <div className="card center col" style={{ alignItems: 'center' }}><Barcode value={card.cardNumber} />{card.portalUrl && <QR value={card.portalUrl} size={130} />}</div>}
    </div>
  );
}

export { maskCard, dt };
