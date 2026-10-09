import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Ban, CheckCircle2, AlertOctagon, Repeat, Scale, Stamp, Coins, ArrowRightLeft, Undo2, Link2, Printer, RotateCw, Nfc, Tag, ShieldCheck, ShieldAlert } from 'lucide-react';
import { api } from '../../lib/api.js';
import { money, int, date, dt, groupCard } from '../../lib/format.js';
import { useSocket, useWatch } from '../../lib/realtime.js';
import { useCardReads, useKeyboardWedge } from '../../lib/readers.js';
import { Button, Card, PageHeader, useLoad, Async, StatusBadge, Badge, Kv, Modal, Input, Textarea, useAction, useConfirm, Chips, Switch } from '../../components/ui.jsx';
import { Barcode, QR, CardScanInput } from '../../components/domain.jsx';
import { browserPrint } from '../../lib/printer.js';
import { useAuth } from '../../lib/auth.jsx';
import { Timeline } from './MemberDetail.jsx';
import { PrintLabelsModal } from './Cards.jsx';

export function A4CardDetails({ card, settings, staff }) {
  const logo = settings?.branding?.logoMediaId ? `/api/public/media/${settings.branding.logoMediaId}` : null;
  return (
    <div id="a4-print" className="a4">
      <div className="row between">{logo ? <img src={logo} alt="" style={{ maxHeight: 60 }} /> : <b style={{ fontSize: 22 }}>{settings?.general?.storeName}</b>}<div className="right"><b>{settings?.general?.storeName}</b><div className="small">{settings?.general?.address}</div></div></div>
      <h2 style={{ marginTop: 24 }}>Card Details / รายละเอียดบัตร</h2>
      <div className="row top" style={{ gap: 30, marginTop: 16 }}>
        <div className="grow"><table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}><tbody>
          {[['Member name', card.member?.name || 'Guest'], ['Member ID', card.member?.memberCode], ['Phone', card.member?.phone], ['Card number', groupCard(card.cardNumber)], ['Card type', card.cardType], ['Tier', card.member?.tier?.name], ['Balance', money(card.balance)], ['Points', int(card.points)], ['Stamps', int(card.stamps)], ['Issue date', date(card.issuedAt)], ['Expiration', card.expiresAt ? date(card.expiresAt) : 'No expiration'], ['Status', card.status]]
            .map(([k, v]) => <tr key={k}><td style={{ padding: '6px 0', color: '#555', width: '40%' }}>{k}</td><td style={{ padding: '6px 0', fontWeight: 600 }}>{v || '—'}</td></tr>)}
        </tbody></table></div>
        <div className="center col" style={{ alignItems: 'center' }}><Barcode value={card.cardNumber} />{card.portalUrl && <><QR value={card.portalUrl} size={150} /><div className="small">Scan to open your card portal<br />(PIN required)</div></>}</div>
      </div>
      <h3 style={{ marginTop: 30 }}>Terms</h3>
      <ol className="small"><li>Card balance can be used for games, attractions and food within participating outlets.</li><li>Balance is not exchangeable for cash except under the store refund policy.</li><li>Report lost cards immediately — balance can be transferred to a replacement card.</li><li>Keep your 6-digit PIN secret. Staff will never ask for it.</li></ol>
      <div className="row between small" style={{ marginTop: 40, borderTop: '1px solid #ccc', paddingTop: 8 }}><span>Printed {new Date().toLocaleString('en-GB')}</span><span>Printed by {staff?.firstName} {staff?.lastName} ({staff?.employeeCode})</span></div>
    </div>
  );
}

function AmountModal({ open, title, label, onClose, onSubmit, signedInput = true, integer }) {
  const [sign, setSign] = useState(1);
  const [v, setV] = useState('');
  const [reason, setReason] = useState('');
  const [run, busy] = useAction();
  const n = Number(v) * sign;
  return (
    <Modal open={open} title={title} onClose={() => onClose()} footer={<><Button onClick={() => onClose()}>Cancel</Button><Button variant="primary" loading={busy} disabled={!v || Number(v) <= 0 || (sign < 0 && reason.length < 3)} onClick={() => run(() => onSubmit(integer ? Math.trunc(n) : n, reason), { success: 'Saved' }).then(() => { setV(''); setReason(''); onClose(true); })}>Confirm</Button></>}>
      <div className="col">
        {signedInput && <Chips options={[{ value: 1, label: '+ Add' }, { value: -1, label: '− Remove' }]} value={sign} onChange={setSign} />}
        {integer && <Chips options={[1, 2, 5, 10].map((x) => ({ value: x, label: `${sign > 0 ? '+' : '−'}${x}` }))} value={Number(v)} onChange={(x) => setV(String(x))} />}
        <Input label={label} size="xl" type="number" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} autoFocus />
        <Textarea label={`Reason${sign < 0 ? ' (required)' : ''}`} value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="xs muted">Recorded in the ledger and audit log with old value, adjustment, new value, staff and approver.</div>
      </div>
    </Modal>
  );
}

export default function CardDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can, settings, staff } = useAuth();
  const confirm = useConfirm();
  const [run] = useAction();
  const [modal, setModal] = useState(null);
  const [newCard, setNewCard] = useState(null);
  const [rfid, setRfid] = useState('');
  const st = useLoad(() => api.get(`/cards/${id}`), [id]);
  useWatch(`card:${id}`);
  useSocket({ 'card:update': (e) => (!e.cardId || e.cardId === id) && st.reload(true) });
  useCardReads((v) => modal === 'rfid' && setRfid(v), modal === 'rfid');
  useKeyboardWedge((v) => modal === 'rfid' && setRfid(v), { enabled: modal === 'rfid', whenFocused: true });
  const reload = () => st.reload(true);
  const status = async (path, label, needReason = true) => {
    const reason = needReason ? await confirm({ title: label, reason: true, danger: true }) : await confirm({ title: label, message: 'Reactivate this card?' });
    if (!reason) return;
    await run(() => api.post(`/cards/${id}/${path}`, needReason ? { reason } : {}), { success: label }).then(reload);
  };
  return (
    <Async state={st}>{(c) => (
      <div>
        <PageHeader title={<span className="mono">{groupCard(c.cardNumber)}</span>}
          subtitle={<span>{c.cardType} card · <StatusBadge status={c.status} /> {c.member ? <> · <Link to={`/members/${c.member.id}`}>{c.member.name} ({c.member.memberCode})</Link> {c.member.tier && <Badge>{c.member.tier.name}</Badge>}</> : ' · Guest'}
            {c.replacedBy && <> · replaced by <Link to={`/cards/${c.replacedBy}`}>new card</Link></>}{c.replacedFrom && <> · replaces <Link to={`/cards/${c.replacedFrom}`}>old card</Link></>}</span>}
          actions={<>
            {can('card.print') && <Button icon={Printer} onClick={() => setModal('a4')}>Print card details</Button>}
            {can('card.print') && <Button icon={Tag} onClick={() => setModal('label')}>Label</Button>}
          </>} />
        {c.blockReason && <div className="alert danger mb"><AlertOctagon size={18} /> {c.blockReason}</div>}
        <div className="grid g4">
          <Card><div className="stat"><span className="label">Balance</span><span className="value">{money(c.balance)}</span><span className="sub">Deposit held {money(c.depositAmount)}</span></div></Card>
          <Card><div className="stat"><span className="label">Points</span><span className="value">{int(c.points)}</span></div></Card>
          <Card><div className="stat"><span className="label">{settings?.stamp?.name || 'Stamps'}</span><span className="value">{int(c.stamps)}</span></div></Card>
          <Card><div className="stat"><span className="label">Ledger reconciliation</span><span className={`value ${c.reconciliation.ok ? 'success' : 'danger'}`} style={{ fontSize: '1.2rem' }}>{c.reconciliation.ok ? <><ShieldCheck /> Balanced</> : <><ShieldAlert /> MISMATCH</>}</span><span className="sub">Ledger {money(c.reconciliation.ledger_balance)}</span></div></Card>
        </div>
        <div className="card mt row wrap">
          {c.status === 'ACTIVE' && can('card.block') && <><Button icon={Ban} onClick={() => status('block', 'Block card')}>Block</Button><Button icon={AlertOctagon} onClick={() => status('lost', 'Report lost')}>Report lost</Button></>}
          {['BLOCKED', 'LOST', 'EXPIRED'].includes(c.status) && can('card.unblock') && <Button icon={CheckCircle2} onClick={() => status('unblock', 'Unblock card', false)}>Unblock / reactivate</Button>}
          {['ACTIVE', 'BLOCKED', 'LOST', 'EXPIRED'].includes(c.status) && can('card.replace') && <Button icon={Repeat} onClick={() => setModal('replace')}>Replace card</Button>}
          {c.status !== 'INACTIVE' && c.status !== 'REPLACED' && <>
            {can('card.adjust_balance') && <Button icon={Scale} onClick={() => setModal('balance')}>Adjust balance</Button>}
            {(can('stamp.add') || can('stamp.adjust')) && <Button icon={Stamp} onClick={() => setModal('stamps')}>Stamps</Button>}
            {(can('point.add') || can('point.adjust')) && <Button icon={Coins} onClick={() => setModal('points')}>Points</Button>}
            {can('stamp.convert') && settings?.stamp?.conversion?.enabled && <Button onClick={() => run(() => api.post(`/cards/${id}/convert-stamps`, {}), { success: 'Stamps converted' }).then(reload)}>Convert stamps → points</Button>}
            {can('card.transfer') && <Button icon={ArrowRightLeft} onClick={() => setModal('transfer')}>Transfer balance</Button>}
            {can('card.return') && c.cardType === 'GUEST' && <Button icon={Undo2} onClick={() => setModal('return')}>Return card / refund deposit</Button>}
            {can('card.issue') && !c.member && <Button icon={Link2} onClick={() => setModal('link')}>Link to member</Button>}
          </>}
          {c.status === 'INACTIVE' && can('card.issue') && <Button variant="primary" onClick={() => nav('/pos')}>Issue at POS</Button>}
          {can('card.issue') && <Button icon={Nfc} onClick={() => { setRfid(c.rfidUid || ''); setModal('rfid'); }}>RFID / NFC UID</Button>}
          {can('card.print') && <Button icon={RotateCw} onClick={async () => { if (await confirm({ title: 'Rotate QR token', message: 'Previously printed QR codes for this card will stop working.' })) run(() => api.post(`/cards/${id}/portal-token/rotate`), { success: 'New QR issued' }).then(reload); }}>Rotate QR</Button>}
        </div>
        <div className="grid mt" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)' }}>
          <div className="col">
            <Card title="Codes" className="center"><Barcode value={c.cardNumber} />{c.portalUrl && <div className="mt-s"><QR value={c.portalUrl} size={150} /><div className="xs muted">Card portal QR (secure token; PIN required)</div></div>}</Card>
            <Card title="Details"><Kv items={[['Card type', c.cardType], ['RFID UID', c.rfidUid && <code key="r">{c.rfidUid}</code>], ['Batch', c.batchNo], ['Issued', dt(c.issuedAt)], ['Expires', c.expiresAt ? date(c.expiresAt) : 'Never'], ['Last used', dt(c.lastUsedAt)], ['Last top-up', dt(c.lastTopupAt)], ['Total top-up', money(c.totalTopup)], ['Total spend', money(c.totalSpend)], ['Total plays', int(c.totalPlay)]]} /></Card>
          </div>
          <Card title="Card history"><Timeline path={`/cards/${id}/history`} /></Card>
        </div>

        <AmountModal open={modal === 'balance'} title="Adjust balance" label="Amount ฿" onClose={(ok) => { setModal(null); ok && reload(); }} onSubmit={(delta, reason) => api.post(`/cards/${id}/adjust`, { delta, reason })} />
        <AmountModal open={modal === 'stamps'} integer title="Stamps" label="Stamps" onClose={(ok) => { setModal(null); ok && reload(); }} onSubmit={(delta, reason) => api.post(`/cards/${id}/stamps`, { delta, reason: reason || undefined })} />
        <AmountModal open={modal === 'points'} integer title="Points" label="Points" onClose={(ok) => { setModal(null); ok && reload(); }} onSubmit={(delta, reason) => api.post(`/cards/${id}/points`, { delta, reason: reason || 'Manual points' })} />
        <Modal open={modal === 'replace'} title="Replace card" onClose={() => { setModal(null); setNewCard(null); }}>
          <div className="col">
            <div className="alert">Moves {money(c.balance)}, {c.points} points, {c.stamps} stamps and the deposit to the new card. This card becomes <b>REPLACED</b> immediately.</div>
            {!newCard ? <CardScanInput placeholder="Tap / scan the NEW (unused) card" onCard={(n) => setNewCard(n)} /> : <>
              <div>New card: <b className="mono">{n2(newCard.cardNumber)}</b> <StatusBadge status={newCard.status} /></div>
              {newCard.status !== 'INACTIVE' && <div className="alert danger">The new card must be unused (INACTIVE).</div>}
              <ReplaceConfirm disabled={newCard.status !== 'INACTIVE'} fee={settings?.card?.replacementFee} onConfirm={(reason, fee) => run(() => api.post(`/cards/${id}/replace`, { newCardId: newCard.id, reason, chargeFeeFromBalance: fee }), { success: 'Card replaced' }).then((r) => { setModal(null); setNewCard(null); nav(`/cards/${r.newCard.id}`); })} />
            </>}
          </div>
        </Modal>
        <Modal open={modal === 'transfer'} title="Transfer balance to another card" onClose={() => { setModal(null); setNewCard(null); }}>
          {!newCard ? <CardScanInput placeholder="Tap / scan destination card" onCard={setNewCard} /> : <TransferForm to={newCard} max={c.balance} onSubmit={(amount, reason) => run(() => api.post('/cards/transfer', { fromCardId: id, toCardId: newCard.id, amount, reason }), { success: 'Transferred' }).then(() => { setModal(null); setNewCard(null); reload(); })} />}
        </Modal>
        <ReturnModal open={modal === 'return'} card={c} onClose={(ok) => { setModal(null); ok && reload(); }} />
        <Modal open={modal === 'link'} title="Link card to member" onClose={() => setModal(null)}><LinkMember onPick={(m) => run(() => api.post(`/cards/${id}/link`, { memberId: m.id }), { success: 'Linked' }).then(() => { setModal(null); reload(); })} /></Modal>
        <Modal open={modal === 'rfid'} title="RFID / NFC UID" onClose={() => setModal(null)} footer={<><Button onClick={() => run(() => api.post(`/cards/${id}/rfid`, { uid: null }), { success: 'Cleared' }).then(() => { setModal(null); reload(); })}>Clear</Button><Button variant="primary" disabled={rfid.length < 4} onClick={() => run(() => api.post(`/cards/${id}/rfid`, { uid: rfid }), { success: 'RFID linked' }).then(() => { setModal(null); reload(); })}>Save</Button></>}>
          <div className="col"><div className="small muted">Tap the physical card on the connected reader (or type the UID). Readers then identify this card by its chip UID.</div><Input label="UID" value={rfid} onChange={(e) => setRfid(e.target.value.toUpperCase())} autoFocus /></div>
        </Modal>
        <Modal open={modal === 'a4'} title="Print card details (A4)" size="xwide" onClose={() => setModal(null)} footer={<Button variant="primary" icon={Printer} onClick={() => browserPrint('a4-print')}>Print</Button>}>
          <div style={{ overflow: 'auto', maxHeight: '65vh', background: '#eee', padding: 10 }}><A4CardDetails card={c} settings={settings} staff={staff} /></div>
        </Modal>
        <PrintLabelsModal open={modal === 'label'} cards={[{ card_number: c.cardNumber, portalUrl: c.portalUrl }]} onClose={() => setModal(null)} />
      </div>
    )}</Async>
  );
}
const n2 = groupCard;

function ReplaceConfirm({ onConfirm, disabled, fee }) {
  const [reason, setReason] = useState('');
  const [chargeFee, setChargeFee] = useState(false);
  return (
    <div className="col">
      <Textarea label="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
      {fee > 0 && <Switch label={`Deduct replacement fee ${money(fee)} from the transferred balance`} checked={chargeFee} onChange={setChargeFee} />}
      <Button variant="primary" size="lg" disabled={disabled || reason.length < 3} onClick={() => onConfirm(reason, chargeFee)}>Confirm replacement</Button>
    </div>
  );
}
function TransferForm({ to, max, onSubmit }) {
  const [a, setA] = useState('');
  const [r, setR] = useState('');
  return (
    <div className="col"><div>To card <b className="mono">{to.cardNumber}</b> ({to.member?.name || 'Guest'}) — balance {money(to.balance)}</div>
      <Input label={`Amount (max ${money(max)})`} type="number" value={a} onChange={(e) => setA(e.target.value)} /><Textarea label="Reason" value={r} onChange={(e) => setR(e.target.value)} />
      <Button variant="primary" disabled={!(Number(a) > 0) || Number(a) > max || r.length < 3} onClick={() => onSubmit(Number(a), r)}>Transfer</Button></div>
  );
}
function ReturnModal({ open, card, onClose }) {
  const [refund, setRefund] = useState(false);
  const [reason, setReason] = useState('');
  const [run, busy] = useAction();
  const { settings } = useAuth();
  const cash = (settings?.card?.depositRefundable === false ? 0 : card.depositAmount) + (refund ? card.balance : 0);
  return (
    <Modal open={open} title="Return guest card" onClose={() => onClose()} footer={<><Button onClick={() => onClose()}>Cancel</Button><Button variant="primary" loading={busy} disabled={card.balance > 0 && !refund} onClick={() => run(() => api.post(`/cards/${card.id}/return`, { refundBalance: refund, reason: reason || undefined }), { success: (r) => `Return cash ${money(r.cashOut)} to customer` }).then(() => onClose(true))}>Confirm return</Button></>}>
      <div className="col">
        <div>Deposit to refund: <b>{money(card.depositAmount)}</b></div>
        {card.balance > 0 && <><div className="alert warning">Card still holds {money(card.balance)}.</div><Switch label={`Refund remaining balance ${money(card.balance)} in cash (requires refund permission / approval)`} checked={refund} onChange={setRefund} /></>}
        <Textarea label="Note" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="big">Cash to give back: {money(cash)}</div>
        <div className="xs muted">The card is reset to INACTIVE stock and can be re-issued.</div>
      </div>
    </Modal>
  );
}
function LinkMember({ onPick }) {
  const [q, setQ] = useState('');
  const [m, setM] = useState(null);
  const [err, setErr] = useState(null);
  return (
    <div className="col"><form className="row" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { setM(await api.get(`/members/lookup?${/^MBR/i.test(q) ? 'code' : 'phone'}=${encodeURIComponent(q)}`)); } catch (x) { setErr(x.message); } }}>
      <Input className="grow" placeholder="Member phone or MBR ID" value={q} onChange={(e) => setQ(e.target.value)} /><Button type="submit">Find</Button></form>
      {err && <div className="alert danger">{err}</div>}
      {m && <div className="card tight row between"><span>{m.firstName} {m.lastName} · {m.memberCode}</span><Button variant="primary" onClick={() => onPick(m)}>Link</Button></div>}</div>
  );
}
