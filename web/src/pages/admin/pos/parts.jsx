import { useState } from 'react';
import { UserPlus, Search, X, MonitorPlay, Unplug, Clock, ArrowDownToLine, ArrowUpFromLine, LogOut as CloseIcon, Phone } from 'lucide-react';
import { api } from '../../../lib/api.js';
import { money, maskPhone } from '../../../lib/format.js';
import { Button, Input, Modal, useAction, useLoad, Badge, Select, Kv } from '../../../components/ui.jsx';
import { FormFields, validate } from '../../../components/entity.jsx';
import { useAuth } from '../../../lib/auth.jsx';

export function RegisterMemberModal({ open, onClose, initialPhone = '' }) {
  const { settings } = useAuth();
  const mf = settings?.member?.fields || {};
  const fields = [
    { name: 'phone', label: 'Phone number', required: true, pattern: /^\+?[0-9]{9,15}$/, patternMessage: 'Phone must be 9–15 digits' },
    { name: 'firstName', label: 'First name', required: true }, { name: 'lastName', label: 'Last name', required: true }, { name: 'nickname', label: 'Nickname' },
    { name: 'pin', label: 'Member PIN (6 digits)', type: 'password', required: true, pattern: /^[0-9]{6}$/, patternMessage: 'PIN must be exactly 6 digits' },
    mf.email?.enabled && { name: 'email', label: 'Email', required: mf.email.required },
    mf.birthday?.enabled && { name: 'birthday', label: 'Birthday', type: 'date', required: mf.birthday.required },
    mf.gender?.enabled && { name: 'gender', label: 'Gender', type: 'select', required: mf.gender.required, options: ['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED'].map((v) => ({ value: v, label: v })) },
    mf.address?.enabled && { name: 'address', label: 'Address', type: 'textarea', required: mf.address.required, full: true },
    ...(settings?.member?.customFields || []).filter((c) => c.key).map((c) => ({ name: `cf_${c.key}`, label: c.label || c.key, type: c.type === 'number' ? 'number' : c.type === 'date' ? 'date' : 'text', required: c.required })),
  ].filter(Boolean);
  const [form, setForm] = useState({ phone: initialPhone });
  const [err, setErr] = useState(null);
  const [run, busy] = useAction();
  const submit = async () => {
    const e = validate(fields, form); if (e) return setErr(e);
    const customFields = Object.fromEntries(Object.entries(form).filter(([k]) => k.startsWith('cf_')).map(([k, v]) => [k.slice(3), v]));
    const body = Object.fromEntries(Object.entries(form).filter(([k, v]) => !k.startsWith('cf_') && v !== ''));
    try { const m = await run(() => api.post('/members', { ...body, customFields }), { success: 'Member registered' }); setForm({}); onClose(m); } catch (x) { setErr(x.message); }
  };
  return (
    <Modal open={open} title="Register member" onClose={() => onClose(null)} size="wide" footer={<><Button onClick={() => onClose(null)}>Cancel</Button><Button variant="primary" icon={UserPlus} loading={busy} onClick={submit}>Register</Button></>}>
      {err && <div className="alert danger mb">{err}</div>}
      <FormFields fields={fields} form={form} setForm={setForm} />
    </Modal>
  );
}

/** Identify the customer: phone / member ID lookup, or send to customer display. */
export function MemberLookup({ onMember, onRegister, onAskDisplay, paired }) {
  const [q, setQ] = useState('');
  const [err, setErr] = useState(null);
  const [run, busy] = useAction();
  const find = async () => {
    setErr(null);
    const v = q.trim();
    const isCode = /^MBR/i.test(v);
    try {
      const m = await api.get(`/members/lookup?${isCode ? 'code' : 'phone'}=${encodeURIComponent(v)}`);
      setQ(''); onMember(m);
    } catch (e) { setErr(e.code === 'MEMBER_NOT_FOUND' ? 'MEMBER NOT FOUND' : e.message); }
  };
  return (
    <div className="col gap-s">
      <form className="row" onSubmit={(e) => { e.preventDefault(); run(find).catch(() => {}); }}>
        <div className="grow" style={{ position: 'relative' }}><Phone size={18} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
          <input className="input" style={{ paddingLeft: 38 }} placeholder="Member phone or MBR ID" value={q} onChange={(e) => setQ(e.target.value)} inputMode="tel" aria-label="Member phone or ID" /></div>
        <Button type="submit" icon={Search} loading={busy} disabled={!q.trim()}>Find</Button>
      </form>
      {err && <div className="alert danger row between">{err}<Button size="sm" icon={UserPlus} onClick={() => onRegister(q)}>Register</Button></div>}
      <div className="row wrap">
        <Button size="sm" icon={UserPlus} onClick={() => onRegister('')}>New member</Button>
        {paired && <Button size="sm" icon={MonitorPlay} onClick={onAskDisplay}>Ask on customer display</Button>}
      </div>
    </div>
  );
}

export function MemberChip({ member, onClear }) {
  if (!member) return null;
  return (
    <div className="card tight row between" style={{ borderColor: 'var(--secondary)' }}>
      <div><div className="bold">{member.firstName} {member.lastName} {member.tier && <Badge tone="primary">{member.tier.name}</Badge>}</div>
        <div className="xs muted">{member.memberCode} · {maskPhone(member.phone)} · {member.cards?.filter((c) => c.status === 'ACTIVE').length || 0} active card(s) · {money(member.balance)}</div></div>
      <Button variant="ghost" size="sm" icon={X} onClick={onClear} aria-label="Clear member" />
    </div>
  );
}

export function DisplayControl({ pairing }) {
  const [open, setOpen] = useState(false);
  const p = pairing.pairing;
  return (
    <>
      <Button size="sm" variant={pairing.paired ? 'success' : ''} icon={MonitorPlay} onClick={() => setOpen(true)}>{pairing.paired ? 'Display connected' : 'Connect Customer Display'}</Button>
      <Modal open={open} title="Customer Display" onClose={() => setOpen(false)}>
        {pairing.paired ? <div className="col"><div className="alert success">Customer display is paired with this POS session.</div><Button icon={Unplug} variant="danger" onClick={() => pairing.close()}>Disconnect display</Button></div>
          : p?.status === 'WAITING' ? <div className="col center" style={{ alignItems: 'center' }}><div className="muted">On the customer display open <b>{location.origin}/display</b> and enter:</div><div className="giant mono" style={{ letterSpacing: '.2em' }}>{p.code}</div><div className="small muted">Code valid for 10 minutes</div><Button onClick={() => pairing.reload()}>Refresh status</Button></div>
            : <Button variant="primary" size="lg" icon={MonitorPlay} onClick={() => pairing.create()}>Generate pairing code</Button>}
      </Modal>
    </>
  );
}

export function ShiftBar({ shift, reload }) {
  const { can } = useAuth();
  const [mode, setMode] = useState(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [run, busy] = useAction();
  const close = () => { setMode(null); setAmount(''); setReason(''); };
  if (!shift) {
    return (
      <div className="alert warning row between"><span><Clock size={16} /> No open shift. Open a cashier shift to take payments.</span>
        {can('pos.shift') && <div className="row"><input className="input" style={{ width: 140 }} type="number" placeholder="Opening cash" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Button variant="primary" loading={busy} onClick={() => run(() => api.post('/shifts/open', { openingCash: Number(amount || 0) }), { success: 'Shift opened' }).then(() => { setAmount(''); reload(); })}>Open shift</Button></div>}
      </div>
    );
  }
  return (
    <div className="row wrap small">
      <Badge tone="info"><Clock size={12} /> {shift.shift.shift_no}</Badge><span className="muted">Expected cash {money(shift.cash.expected)}</span>
      {can('pos.cash_movement') && <><Button size="sm" icon={ArrowDownToLine} onClick={() => setMode('CASH_IN')}>Cash in</Button><Button size="sm" icon={ArrowUpFromLine} onClick={() => setMode('CASH_OUT')}>Cash out</Button></>}
      {can('pos.shift') && <Button size="sm" icon={CloseIcon} onClick={() => setMode('CLOSE')}>Close shift</Button>}
      <Modal open={!!mode} title={mode === 'CLOSE' ? 'Close shift' : mode === 'CASH_IN' ? 'Cash in' : 'Cash out'} onClose={close}
        footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" loading={busy} disabled={!amount || (mode !== 'CLOSE' && reason.length < 3)} onClick={() => run(() => (mode === 'CLOSE'
          ? api.post(`/shifts/${shift.shift.id}/close`, { actualCash: Number(amount) }) : api.post('/shifts/cash', { type: mode, amount: Number(amount), reason })), { success: mode === 'CLOSE' ? 'Shift closed' : 'Recorded' }).then(() => { close(); reload(); })}>Confirm</Button></>}>
        <div className="col">
          {mode === 'CLOSE' && <Kv items={[['Opening', money(shift.cash.opening)], ['Cash sales', money(shift.cash.sales)], ['Cash refunds', `-${money(shift.cash.refunds)}`], ['Cash in', money(shift.cash.cashIn)], ['Cash out', `-${money(shift.cash.cashOut)}`], ['Expected cash', <b key="e">{money(shift.cash.expected)}</b>]]} />}
          <Input label={mode === 'CLOSE' ? 'Actual cash counted' : 'Amount'} type="number" inputMode="decimal" size="lg" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          {mode === 'CLOSE' && amount !== '' && <div className={`big ${Number(amount) - shift.cash.expected < 0 ? 'danger' : 'success'}`}>Over / Short: {money(Number(amount) - shift.cash.expected)}</div>}
          {mode !== 'CLOSE' && <Input label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />}
        </div>
      </Modal>
    </div>
  );
}

export { Select };
