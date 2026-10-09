import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate, useParams, Link } from 'react-router-dom';
import { Home, CreditCard, Gift, History, User, Wallet, Megaphone, Bell, LogOut, Loader2, CheckCircle2, FlaskConical, QrCode, RefreshCw, Coins, Stamp } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useSocket } from '../../lib/realtime.js';
import { I18nProvider, useI18n, LanguageSwitcher } from '../../lib/i18n.jsx';
import { applyPublicSettings } from '../../lib/auth.jsx';
import { money, int, dt, date, TXN_LABEL } from '../../lib/format.js';
import { Button, Input, Select, Card, Badge, Empty, Chips, useToast, Modal, Spinner, useLoad } from '../../components/ui.jsx';
import { DigitalCard, QR, mediaSrc } from '../../components/domain.jsx';

const Ctx = createContext(null);
const useMember = () => useContext(Ctx);

function useProvider() {
  const [state, setState] = useState({ loading: true, me: null, settings: null });
  const refresh = useCallback(async () => {
    const settings = await api.get('/public/settings').catch(() => null);
    if (settings) applyPublicSettings(settings, 'member');
    try { const me = await api.get('/member/me', { approval: false }); setState({ loading: false, me, settings }); } catch { setState({ loading: false, me: null, settings }); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { ...state, refresh, setMe: (me) => setState((s) => ({ ...s, me })) };
}

function PinInput({ label, value, onChange, autoFocus }) {
  return <Input label={label} type="password" inputMode="numeric" autoComplete="one-time-code" maxLength={6} size="lg" value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus={autoFocus} />;
}

function Shell({ children }) {
  const { t } = useI18n();
  const { me, settings } = useMember();
  const logo = settings?.branding?.logoMediaId ? mediaSrc(settings.branding.logoMediaId) : null;
  return (
    <div style={{ minHeight: '100%', paddingBottom: me ? 76 : 0 }}>
      <header className="topbar" style={{ position: 'sticky' }}>
        <Link to="/m" className="row" style={{ color: 'inherit' }}>{logo ? <img src={logo} alt="" style={{ height: 32 }} /> : <img src="/icon.svg" alt="" width={30} />}<b>{settings?.general?.storeName}</b></Link>
        <div className="grow" /><LanguageSwitcher compact />
        {me && <Link to="/m/notifications" className="btn ghost icon" aria-label={t('portal.notifications')}><Bell size={18} /></Link>}
      </header>
      <main className="content" style={{ maxWidth: 760 }}>{children}</main>
      {me && <nav className="no-print" style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: 'var(--surface)', borderTop: '1px solid var(--border)', display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', zIndex: 20, paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {[['/m', Home, 'portal.home'], ['/m/card', CreditCard, 'portal.myCard'], ['/m/rewards', Gift, 'portal.rewards'], ['/m/history', History, 'portal.history'], ['/m/profile', User, 'portal.profile']].map(([to, I, k]) => (
          <NavLink key={to} to={to} end className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={{ flexDirection: 'column', gap: 2, fontSize: '.72rem', borderRadius: 0, justifyContent: 'center' }}><I size={20} />{t(k)}</NavLink>))}
      </nav>}
    </div>
  );
}

function Login() {
  const { t } = useI18n();
  const { refresh } = useMember();
  const nav = useNavigate();
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await api.post('/member/login', { phone, pin }, { approval: false }); await refresh(); nav('/m'); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Card><form className="col" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <h1>{t('portal.login')}</h1>
      <Input label={t('phone.label')} size="lg" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^0-9+]/g, ''))} autoFocus />
      <PinInput label={t('portal.pin')} value={pin} onChange={setPin} />
      {err && <div className="alert danger">{err}</div>}
      <Button type="submit" variant="primary" size="lg" loading={busy} disabled={phone.length < 9 || pin.length !== 6}>{t('portal.login')}</Button>
      <div className="row between small"><Link to="/m/forgot">{t('portal.forgot')}</Link><span>{t('portal.noAccount')} <Link to="/m/register">{t('portal.register')}</Link></span></div>
    </form></Card>
  );
}

function Register() {
  const { t, lang } = useI18n();
  const { refresh, settings } = useMember();
  const nav = useNavigate();
  const policies = useLoad(() => api.get('/member/policies'), []);
  const fields = settings?.member?.fields || {};
  const [f, setF] = useState({ phone: '', firstName: '', lastName: '', pin: '', pin2: '', email: '', birthday: '', gender: '', address: '' });
  const [cf, setCf] = useState({});
  const [accept, setAccept] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    setErr(null);
    if (f.pin !== f.pin2) return setErr('PIN mismatch');
    setBusy(true);
    try {
      const body = { phone: f.phone, firstName: f.firstName, lastName: f.lastName, pin: f.pin, language: lang, customFields: cf, acceptedPolicyIds: accept ? (policies.data?.items || []).map((p) => p.id) : [] };
      for (const k of ['email', 'birthday', 'gender', 'address']) if (fields[k]?.enabled && f[k]) body[k] = f[k];
      await api.post('/member/register', body, { approval: false }); await refresh(); nav('/m');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Card><form className="col" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <h1>{t('portal.register')}</h1>
      <Input label={`${t('phone.label')} *`} size="lg" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/[^0-9+]/g, '') })} />
      <div className="grid g2"><Input label={`${t('portal.firstName')} *`} value={f.firstName} onChange={set('firstName')} /><Input label={`${t('portal.lastName')} *`} value={f.lastName} onChange={set('lastName')} /></div>
      {fields.email?.enabled && <Input label={`${t('portal.email')}${fields.email.required ? ' *' : ''}`} type="email" value={f.email} onChange={set('email')} />}
      {fields.birthday?.enabled && <Input label={`${t('portal.birthday')}${fields.birthday.required ? ' *' : ''}`} type="date" value={f.birthday} onChange={set('birthday')} />}
      {fields.gender?.enabled && <Select label={`${t('portal.gender')}${fields.gender.required ? ' *' : ''}`} value={f.gender} onChange={set('gender')} placeholder="—" options={['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED'].map((g) => ({ value: g, label: t(`gender.${g}`) }))} />}
      {fields.address?.enabled && <Input label={`${t('portal.address')}${fields.address.required ? ' *' : ''}`} value={f.address} onChange={set('address')} />}
      {(settings?.member?.customFields || []).filter((c) => c.key).map((c) => <Input key={c.key} label={`${c.label || c.key}${c.required ? ' *' : ''}`} type={c.type === 'date' ? 'date' : c.type === 'number' ? 'number' : 'text'} value={cf[c.key] || ''} onChange={(e) => setCf({ ...cf, [c.key]: e.target.value })} />)}
      <div className="grid g2"><PinInput label={`${t('portal.pin')} *`} value={f.pin} onChange={(v) => setF({ ...f, pin: v })} /><PinInput label={`${t('portal.pinConfirm')} *`} value={f.pin2} onChange={(v) => setF({ ...f, pin2: v })} /></div>
      {(policies.data?.items || []).length > 0 && <label className="check"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} /><span>{t('portal.acceptAll')} {policies.data.items.map((p) => <a key={p.id} href="#" onClick={(e) => { e.preventDefault(); setView(p); }}> {p.title?.[lang] || p.kind}</a>)}</span></label>}
      {err && <div className="alert danger">{err}</div>}
      <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!f.phone || !f.firstName || !f.lastName || f.pin.length !== 6}>{t('portal.register')}</Button>
      <div className="small">{t('portal.haveAccount')} <Link to="/m/login">{t('portal.login')}</Link></div>
    </form>
    <Modal open={!!view} title={view?.title?.[lang] || view?.kind} onClose={() => setView(null)}><div style={{ whiteSpace: 'pre-line' }}>{view?.content?.[lang] || view?.content?.en}</div></Modal></Card>
  );
}

function Forgot() {
  const { t } = useI18n();
  const [phone, setPhone] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState(null);
  const nav = useNavigate();
  return (
    <Card><div className="col">
      <h1>{t('portal.forgot')}</h1>
      <Input label={t('phone.label')} size="lg" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^0-9+]/g, ''))} />
      {!sent ? <Button variant="primary" size="lg" onClick={async () => { setMsg(null); try { await api.post('/member/forgot-pin/request', { phone }, { approval: false }); setSent(true); setMsg({ ok: t('portal.otpSent') }); } catch (e) { setMsg({ err: e.details?.contactStaff ? t('portal.contactStaff') : e.message }); } }}>{t('next')}</Button> : <>
        <Input label={t('portal.otp')} inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
        <PinInput label={t('portal.newPin')} value={pin} onChange={setPin} />
        <Button variant="primary" size="lg" onClick={async () => { try { await api.post('/member/forgot-pin/verify', { phone, code, newPin: pin }, { approval: false }); nav('/m/login'); } catch (e) { setMsg({ err: e.message }); } }}>{t('confirm')}</Button></>}
      {msg?.ok && <div className="alert success">{msg.ok}</div>}{msg?.err && <div className="alert warning">{msg.err}</div>}
      <Link to="/m/login">{t('back')}</Link>
    </div></Card>
  );
}

function HomePage() {
  const { t } = useI18n();
  const { me, settings } = useMember();
  const card = me.cards.find((c) => c.status === 'ACTIVE');
  const q = me.nextTier?.qualification || {};
  const progress = q.minTopup ? Math.min(100, (me.totalTopup / q.minTopup) * 100) : q.minPoints ? Math.min(100, (me.lifetimePoints / q.minPoints) * 100) : null;
  return (
    <div className="col">
      <h1>{t('welcome')}, {me.nickname || me.firstName}</h1>
      <div className="row wrap small muted"><span>{t('portal.memberId')}: <code>{me.memberCode}</code></span>{me.tier && <Badge tone="primary">{t('tier')}: {me.tier.name}</Badge>}</div>
      {card ? <Link to={`/m/card/${card.id}`} style={{ color: 'inherit' }}><DigitalCard card={card} member={`${me.firstName} ${me.lastName}`} tier={me.tier} storeName={settings?.general?.storeName} showCodes={false} /></Link> : <div className="alert warning">{t('portal.noCard')}</div>}
      <div className="grid g3"><Card><div className="stat"><span className="label">{t('balance')}</span><span className="value">{money(me.balance)}</span></div></Card>
        <Card><div className="stat"><span className="label"><Coins size={14} /> {t('points')}</span><span className="value">{int(me.points)}</span></div></Card>
        <Card><div className="stat"><span className="label"><Stamp size={14} /> {settings?.stamp?.name || t('stamps')}</span><span className="value">{int(me.stamps)}</span></div></Card></div>
      {me.nextTier && progress != null && <Card><div className="small">{t('portal.nextTier', { tier: me.nextTier.name })}</div><div style={{ height: 10, background: 'var(--surface-2)', borderRadius: 99, marginTop: 8 }}><div style={{ width: `${progress}%`, height: '100%', background: 'var(--primary)', borderRadius: 99 }} /></div></Card>}
      <h3>{t('portal.quick')}</h3>
      <div className="grid g3">
        {[['/m/topup', Wallet, 'topup'], [card ? `/m/card/${card.id}` : '/m/card', CreditCard, 'portal.myCard'], ['/m/card', QrCode, 'balance.check'], ['/m/rewards', Gift, 'portal.rewards'], ['/m/promotions', Megaphone, 'promotions'], ['/m/history', History, 'portal.history']].map(([to, I, k]) => (
          <Link key={k} to={to} className="tile center" style={{ alignItems: 'center', justifyContent: 'center', color: 'var(--text)' }}><I size={30} color="var(--primary)" /><b>{t(k)}</b></Link>))}
      </div>
    </div>
  );
}

function CardsPage() {
  const { t } = useI18n();
  const { me } = useMember();
  const { id } = useParams();
  const nav = useNavigate();
  const sel = id || me.cards.find((c) => c.status === 'ACTIVE')?.id || me.cards[0]?.id;
  const st = useLoad(() => (sel ? api.get(`/member/cards/${sel}`) : Promise.resolve(null)), [sel, me]);
  const { settings } = useMember();
  if (!me.cards.length) return <Empty title={t('portal.noCard')} icon={CreditCard} />;
  return (
    <div className="col">
      <h1>{t('portal.myCard')}</h1>
      {me.cards.length > 1 && <Chips options={me.cards.map((c) => ({ value: c.id, label: `••${c.cardNumber.slice(-4)} ${c.status !== 'ACTIVE' ? c.status : ''}` }))} value={sel} onChange={(v) => nav(`/m/card/${v}`)} />}
      {st.data ? <>
        <DigitalCard card={st.data} member={`${me.firstName} ${me.lastName}`} tier={me.tier} storeName={settings?.general?.storeName} />
        <Card><div className="kv"><div>{t('status')}</div><div><Badge tone={st.data.status === 'ACTIVE' ? 'success' : 'danger'}>{st.data.status}</Badge></div><div>{t('expires')}</div><div>{st.data.expiresAt ? date(st.data.expiresAt) : '—'}</div><div>{t('points')}</div><div>{int(st.data.points)}</div><div>{t('stamps')}</div><div>{int(st.data.stamps)}</div></div></Card>
        {st.data.status === 'ACTIVE' && <Link to={`/m/topup?card=${st.data.id}`} className="btn primary lg block"><Wallet size={18} /> {t('topup')}</Link>}
      </> : <Spinner />}
    </div>
  );
}

function TopUpPage() {
  const { t } = useI18n();
  const { me, refresh } = useMember();
  const toast = useToast();
  const cards = me.cards.filter((c) => c.status === 'ACTIVE');
  const [cardId, setCardId] = useState(new URLSearchParams(location.search).get('card') || cards[0]?.id);
  const pk = useLoad(() => api.get('/member/packages'), []);
  const [choice, setChoice] = useState(null);
  const [custom, setCustom] = useState('');
  const [pay, setPay] = useState(null);
  const [busy, setBusy] = useState(false);
  useSocket({ 'payment:update': (e) => { if (pay && e.paymentId === pay.paymentId) { setPay((p) => ({ ...p, status: e.status })); if (e.status === 'PAID') { refresh(); toast.success(t('topup.success')); } } } }, { kind: 'member' }, [pay?.paymentId]);
  useEffect(() => { if (!pay || pay.status !== 'PENDING') return undefined; const iv = setInterval(async () => { const p = await api.get(`/member/payments/${pay.paymentId}`).catch(() => null); if (p && p.status !== 'PENDING') { setPay((x) => ({ ...x, status: p.status })); if (p.status === 'PAID') refresh(); } }, 5000); return () => clearInterval(iv); }, [pay]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cards.length) return <Empty title={t('portal.noCard')} />;
  if (pk.data && !pk.data.gateway.configured) return <div className="alert warning">{t('portal.topupUnavailable')}</div>;
  const amount = choice?.pay_amount ?? Number(custom || 0);
  const start = async () => {
    setBusy(true);
    try { setPay(await api.post('/member/topup', { cardId, packageId: choice?.id, amount: choice ? undefined : Number(custom) }, { approval: false })); } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  if (pay) {
    return (
      <Card className="center col" style={{ alignItems: 'center' }}>
        {pay.status === 'PAID' ? <><CheckCircle2 size={90} color="var(--success)" /><h1>{t('topup.success')}</h1><div className="huge">{money(me.cards.find((c) => c.id === cardId)?.balance)}</div><Link to="/m" className="btn primary lg">{t('done')}</Link></>
          : pay.status === 'PENDING' ? <><h2>{t('pay.scan')}</h2>{pay.qrPayload && <QR value={pay.qrPayload} size={260} />}{pay.redirectUrl && <a className="btn primary" href={pay.redirectUrl}>{t('portal.payNow')}</a>}
            <div className="huge num">{money(pay.amount)}</div><div className="row"><Loader2 style={{ animation: 'spin 1s linear infinite' }} /> {t('pay.waiting')}</div>
            {pay.testMode && <Button icon={FlaskConical} onClick={() => api.post(`/member/payments/${pay.paymentId}/simulate`, {}, { approval: false }).catch((e) => toast.error(e.message))}>{t('portal.testMode')}</Button>}</>
            : <><div className="alert danger">{t('pay.failed')} ({pay.status})</div><Button onClick={() => setPay(null)}>{t('retry')}</Button></>}
      </Card>
    );
  }
  return (
    <div className="col">
      <h1>{t('topup')}</h1>
      {cards.length > 1 && <Select label={t('card.number')} value={cardId} onChange={(e) => setCardId(e.target.value)} options={cards.map((c) => ({ value: c.id, label: `•••• ${c.cardNumber.slice(-4)} — ${money(c.balance)}` }))} />}
      <h3>{t('portal.choosePackage')}</h3>
      <div className="auto-grid">{(pk.data?.items || []).map((p) => (
        <button key={p.id} className={`tile ${choice?.id === p.id ? 'selected' : ''}`} onClick={() => { setChoice(p); setCustom(''); }}>
          <b>{p.name}</b>{Number(p.bonus_amount) > 0 && <Badge tone="success">+{money(p.bonus_amount)} {t('bonus')}</Badge>}<span className="t-price">{money(p.pay_amount)}</span></button>))}</div>
      {pk.data?.allowCustomAmount && <Input label={`${t('portal.customAmount')} (${money(pk.data.minTopup)}–${money(pk.data.maxTopup)})`} type="number" inputMode="decimal" size="lg" value={custom} onChange={(e) => { setCustom(e.target.value); setChoice(null); }} />}
      <Button variant="primary" size="xl" loading={busy} disabled={!(amount > 0)} onClick={start}>{t('portal.payNow')} {amount > 0 && money(amount)}</Button>
    </div>
  );
}

function RewardsPage() {
  const { t } = useI18n();
  const { me, refresh } = useMember();
  const toast = useToast();
  const cards = me.cards.filter((c) => c.status === 'ACTIVE');
  const [cardId, setCardId] = useState(cards[0]?.id);
  const st = useLoad(() => api.get(`/member/rewards${cardId ? `?cardId=${cardId}` : ''}`), [cardId, me]);
  const reds = useLoad(() => api.get('/member/redemptions'), [me]);
  const [confirm, setConfirm] = useState(null);
  const [code, setCode] = useState(null);
  useSocket({ 'redemption:update': () => { reds.reload(true); refresh(); } }, { kind: 'member' });
  const redeem = async () => {
    try { const r = await api.post(`/member/rewards/${confirm.id}/redeem`, { cardId }, { approval: false }); setCode(r); setConfirm(null); reds.reload(true); } catch (e) { toast.error(e.message); }
  };
  return (
    <div className="col">
      <h1>{t('portal.rewards')}</h1>
      {cards.length > 1 && <Select value={cardId} onChange={(e) => setCardId(e.target.value)} options={cards.map((c) => ({ value: c.id, label: `•••• ${c.cardNumber.slice(-4)} — ${c.points} pts / ${c.stamps} st` }))} />}
      <div className="auto-grid">{(st.data?.items || []).map((r) => (
        <div key={r.id} className="tile" style={{ cursor: 'default' }}>
          {r.image_media_id ? <img src={mediaSrc(r.image_media_id)} alt="" style={{ height: 110, objectFit: 'cover', borderRadius: 10 }} /> : <Gift size={48} color="var(--primary)" />}
          <b>{r.name}</b><span className="xs muted">{r.description}</span>
          <span className="bold" style={{ color: 'var(--primary)' }}>{r.points_required > 0 && `${int(r.points_required)} ${t('points')}`} {r.stamps_required > 0 && `${r.stamps_required} ${t('stamps')}`}</span>
          {r.stock <= 0 ? <Badge tone="danger">{t('portal.outOfStock')}</Badge> : <Button variant="primary" size="sm" disabled={!r.eligible} onClick={() => setConfirm(r)}>{r.eligible ? t('portal.redeem') : t('portal.notEligible')}</Button>}
        </div>))}</div>
      {!st.data?.items.length && !st.loading && <Empty />}
      <h3>{t('portal.myRedemptions')}</h3>
      {(reds.data?.items || []).map((r) => (
        <Card key={r.id} className="row between"><div><b>{r.reward_name}</b><div className="xs muted">{dt(r.created_at)}</div></div>
          <div className="row">{r.status === 'PENDING' && <Button size="sm" icon={QrCode} onClick={() => setCode({ code: r.code, reward: { name: r.reward_name }, expiresAt: r.expires_at })}>{r.code}</Button>}<Badge tone={r.status === 'CONFIRMED' ? 'success' : r.status === 'PENDING' ? 'warning' : ''}>{r.status}</Badge></div></Card>))}
      <Modal open={!!confirm} title={t('portal.redeemConfirm')} onClose={() => setConfirm(null)} footer={<><Button onClick={() => setConfirm(null)}>{t('cancel')}</Button><Button variant="primary" onClick={redeem}>{t('confirm')}</Button></>}>
        {confirm && <div className="big">{confirm.name} — {confirm.points_required > 0 && `${int(confirm.points_required)} ${t('points')}`} {confirm.stamps_required > 0 && `${confirm.stamps_required} ${t('stamps')}`}</div>}
      </Modal>
      <Modal open={!!code} title={code?.reward?.name} onClose={() => setCode(null)}>
        {code && <div className="center col" style={{ alignItems: 'center' }}><QR value={`RD/${code.code}`} size={240} /><div className="giant mono">{code.code}</div><div className="muted">{t('portal.redeemCode')}</div><div className="xs">{t('expires')}: {dt(code.expiresAt)}</div></div>}
      </Modal>
    </div>
  );
}

const HFILTERS = [['', 'portal.all'], ['topup', 'topup'], ['play', 'portal.play'], ['point', 'points'], ['stamp', 'stamps'], ['reward', 'portal.rewards'], ['refund', 'portal.refund'], ['adjustment', 'portal.adjustment']];
function HistoryPage() {
  const { t } = useI18n();
  const { me } = useMember();
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const st = useLoad(() => api.get(`/member/timeline?type=${type}&page=${page}&pageSize=30`), [type, page, me]);
  return (
    <div className="col">
      <h1>{t('portal.history')}</h1>
      <Chips options={HFILTERS.map(([v, k]) => ({ value: v, label: t(k) }))} value={type} onChange={(v) => { setType(v); setPage(1); }} />
      {st.loading && !st.data ? <Spinner /> : !st.data?.items.length ? <Empty title={t('portal.empty')} /> : st.data.items.map((x) => {
        const amt = Number(x.amount) + Number(x.bonus);
        return (
          <div key={x.id} className="card tight row between">
            <div><b>{TXN_LABEL[x.type] || x.type}</b>{x.machine_name && <span className="muted"> · {x.machine_name}</span>}<div className="xs muted">{dt(x.created_at)} · ••{x.card_number.slice(-4)}</div></div>
            <div className="right">{amt !== 0 && <div className={`bold num ${amt < 0 ? 'danger' : 'success'}`}>{amt > 0 ? '+' : ''}{money(amt)}</div>}
              <div className="xs">{x.points_delta !== 0 && `${x.points_delta > 0 ? '+' : ''}${x.points_delta} ${t('points')} `}{x.stamps_delta !== 0 && `${x.stamps_delta > 0 ? '+' : ''}${x.stamps_delta} ${t('stamps')}`}</div></div>
          </div>);
      })}
      {st.data?.pages > 1 && <div className="row between"><Button disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('back')}</Button><span>{page}/{st.data.pages}</span><Button disabled={page >= st.data.pages} onClick={() => setPage(page + 1)}>{t('next')}</Button></div>}
    </div>
  );
}

function PromotionsPage() {
  const { t } = useI18n();
  const st = useLoad(() => api.get('/member/promotions'), []);
  return <div className="col"><h1>{t('promotions')}</h1>{!st.data?.items.length ? <Empty title={t('portal.empty')} /> : st.data.items.map((p) => (
    <Card key={p.id}>{p.media_id && <img src={mediaSrc(p.media_id)} alt="" style={{ width: '100%', borderRadius: 10, marginBottom: 8 }} />}<b className="big">{p.name}</b><div>{p.description}</div><div className="xs muted">{p.start_at && date(p.start_at)} – {p.end_at && date(p.end_at)}</div></Card>))}</div>;
}

function NotificationsPage() {
  const { t } = useI18n();
  const st = useLoad(() => api.get('/member/notifications'), []);
  useEffect(() => { api.post('/member/notifications/read', {}, { approval: false }).catch(() => {}); }, []);
  return <div className="col"><h1>{t('portal.notifications')}</h1>{!st.data?.items.length ? <Empty title={t('portal.empty')} /> : st.data.items.map((n) => <Card key={n.id}><b>{n.title}</b>{n.body && <div className="small">{n.body}</div>}<div className="xs muted">{dt(n.created_at)}</div></Card>)}</div>;
}

function ProfilePage() {
  const { t, lang } = useI18n();
  const { me, refresh, settings } = useMember();
  const toast = useToast();
  const nav = useNavigate();
  const [pins, setPins] = useState({ currentPin: '', newPin: '' });
  const cons = useLoad(() => api.get('/member/consents'), []);
  const [view, setView] = useState(null);
  const card = me.cards.find((c) => c.status === 'ACTIVE');
  useEffect(() => { if (lang !== me.language) api.put('/member/me', { language: lang }, { approval: false }).catch(() => {}); }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="col">
      <h1>{t('portal.profile')}</h1>
      <Card><div className="kv"><div>{t('portal.memberId')}</div><div><code>{me.memberCode}</code></div><div>{t('portal.firstName')}</div><div>{me.firstName} {me.lastName}</div><div>{t('phone.label')}</div><div>{me.phone}</div><div>{t('portal.email')}</div><div>{me.email || '—'}</div><div>{t('portal.birthday')}</div><div>{date(me.birthday)}</div><div>{t('tier')}</div><div>{me.tier?.name}</div></div></Card>
      {card && settings?.stamp?.conversion?.enabled && ['MEMBER', 'AUTO'].includes(settings.stamp.conversion.mode) && <Card><Button icon={RefreshCw} onClick={() => api.post(`/member/cards/${card.id}/convert-stamps`, {}, { approval: false }).then(() => { refresh(); toast.success('OK'); }).catch((e) => toast.error(e.message))}>{t('portal.convertStamps')} ({settings.stamp.conversion.stamps} → {settings.stamp.conversion.points})</Button></Card>}
      <Card title={t('portal.changePin')}><div className="col"><PinInput label={t('portal.currentPin')} value={pins.currentPin} onChange={(v) => setPins({ ...pins, currentPin: v })} /><PinInput label={t('portal.newPin')} value={pins.newPin} onChange={(v) => setPins({ ...pins, newPin: v })} />
        <Button variant="primary" disabled={pins.currentPin.length !== 6 || pins.newPin.length !== 6} onClick={() => api.post('/member/change-pin', pins, { approval: false }).then(() => { setPins({ currentPin: '', newPin: '' }); toast.success('OK'); }).catch((e) => toast.error(e.message))}>{t('save')}</Button></div></Card>
      <Card title={t('portal.consents')}>
        {(cons.data?.policies || []).map((p) => <div key={p.id} className="row between" style={{ padding: '6px 0' }}><a href="#" onClick={(e) => { e.preventDefault(); setView(p); }}>{p.title?.[lang] || p.kind} v{p.version}</a>
          {cons.data.items.some((c) => c.policy_id === p.id) ? <Badge tone="success">✓ {date(cons.data.items.find((c) => c.policy_id === p.id).accepted_at)}</Badge> : <Button size="sm" onClick={() => api.post('/member/consents', { policyIds: [p.id], language: lang }, { approval: false }).then(() => cons.reload())}>{t('privacy.accept')}</Button>}</div>)}
      </Card>
      <Button icon={LogOut} onClick={async () => { await api.post('/member/logout', {}, { approval: false }); await refresh(); nav('/m/login'); }}>{t('portal.logout')}</Button>
      <Modal open={!!view} title={view?.title?.[lang] || view?.kind} onClose={() => setView(null)}><div style={{ whiteSpace: 'pre-line' }}>{view?.content?.[lang] || view?.content?.en}</div></Modal>
    </div>
  );
}

function Guard({ children }) {
  const { me, loading } = useMember();
  if (loading) return <Spinner />;
  return me ? children : <Navigate to="/m/login" replace />;
}

function Realtime() {
  const { me, refresh } = useMember();
  useSocket({ 'card:update': () => refresh(), 'member:update': () => refresh(), 'notification:new': () => refresh() }, me ? { kind: 'member' } : null, [me?.id]);
  return null;
}

export default function Portal() {
  const p = useProvider();
  if (p.loading) return <div className="fs"><div className="fs-center"><Loader2 size={48} style={{ animation: 'spin 1s linear infinite' }} /></div></div>;
  return (
    <I18nProvider initial={p.me?.language || p.settings?.language?.default}>
      <Ctx.Provider value={p}>
        <Realtime />
        <Shell>
          <Routes>
            <Route path="login" element={p.me ? <Navigate to="/m" replace /> : <Login />} />
            <Route path="register" element={p.me ? <Navigate to="/m" replace /> : <Register />} />
            <Route path="forgot" element={<Forgot />} />
            <Route index element={<Guard><HomePage /></Guard>} />
            <Route path="card" element={<Guard><CardsPage /></Guard>} />
            <Route path="card/:id" element={<Guard><CardsPage /></Guard>} />
            <Route path="topup" element={<Guard><TopUpPage /></Guard>} />
            <Route path="rewards" element={<Guard><RewardsPage /></Guard>} />
            <Route path="history" element={<Guard><HistoryPage /></Guard>} />
            <Route path="promotions" element={<Guard><PromotionsPage /></Guard>} />
            <Route path="notifications" element={<Guard><NotificationsPage /></Guard>} />
            <Route path="profile" element={<Guard><ProfilePage /></Guard>} />
            <Route path="*" element={<Navigate to="/m" replace />} />
          </Routes>
        </Shell>
      </Ctx.Provider>
    </I18nProvider>
  );
}

export { useMember };
