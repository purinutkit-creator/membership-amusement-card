// Customer-facing second screen, paired to a POS by a 6-digit code. All text via i18n (TH / EN / 中文).
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CreditCard, Delete, ShieldCheck, UserRound, XCircle, Loader2, MonitorSmartphone } from 'lucide-react';
import { tokenClient } from '../../lib/api.js';
import { useSocket } from '../../lib/realtime.js';
import { useKeyboardWedge, useCardReads } from '../../lib/readers.js';
import { I18nProvider, useI18n, LANGS, ERROR_KEY } from '../../lib/i18n.jsx';
import { applyTheme, applyFont } from '../../lib/theme.js';
import { configureSounds, play } from '../../lib/sound.js';
import { money } from '../../lib/format.js';
import { Button, Input } from '../../components/ui.jsx';
import { QR } from '../../components/domain.jsx';
import SignagePlayer from '../../components/SignagePlayer.jsx';

const KEY = 'sc.display.token';
const client = tokenClient('Display', () => localStorage.getItem(KEY));

function Pair({ onPaired }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (c = code) => {
    setBusy(true); setErr(null);
    try { const r = await client.post('/pairings/join', { code: c }); localStorage.setItem(KEY, r.token); onPaired(); } catch (e) { setErr(e.message); setCode(''); } finally { setBusy(false); }
  };
  const press = (k) => { if (k === 'del') setCode(code.slice(0, -1)); else if (code.length < 6) { const v = code + k; setCode(v); if (v.length === 6) submit(v); } };
  return (
    <div className="fs"><div className="fs-center">
      <MonitorSmartphone size={64} color="var(--primary)" /><h1>Customer Display</h1><p className="muted">Enter the 6-digit pairing code shown at the POS (Connect Customer Display)</p>
      <div className="giant mono" style={{ letterSpacing: '.3em', minHeight: '1.2em' }}>{code.padEnd(6, '•')}</div>
      {err && <div className="alert danger">{err}</div>}
      <div className="keypad" style={{ width: 'min(360px, 90vw)' }}>{['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((k) => k === '' ? <span key="x" /> : <button key={k} disabled={busy} onClick={() => press(k)}>{k === 'del' ? <Delete /> : k}</button>)}</div>
    </div></div>
  );
}

function PhonePad({ onSubmit, t }) {
  const [v, setV] = useState('');
  return (
    <div className="col" style={{ width: 'min(440px, 92vw)', alignItems: 'stretch' }}>
      <div className="huge mono center" style={{ minHeight: '1.3em', letterSpacing: '.08em' }}>{v.replace(/(\d{3})(\d{3})(\d+)/, '$1-$2-$3') || <span className="muted big">{t('phone.label')}</span>}</div>
      <div className="keypad">{['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'del'].map((k) => <button key={k} onClick={() => setV(k === 'C' ? '' : k === 'del' ? v.slice(0, -1) : (v + k).slice(0, 15))}>{k === 'del' ? <Delete /> : k}</button>)}</div>
      <Button variant="primary" size="xl" disabled={v.length < 9} onClick={() => onSubmit(v)}>{t('confirm')}</Button>
    </div>
  );
}

function DisplayScreen({ me, onUnpair }) {
  const { t, lang, setLang } = useI18n();
  const s = me.settings.display;
  const [state, setState] = useState(me.state?.screen ? me.state : { screen: 'IDLE' });
  const [langChosen, setLangChosen] = useState(!s.languageSelect);
  const [consented, setConsented] = useState(false);
  const [local, setLocal] = useState(null); // local sub-screen: PRIVACY | PHONE_RESULT | CARD_RESULT
  const lastActivity = useRef(Date.now());
  const send = useCallback((type, value) => client.post('/display/input', { type, value }).catch(() => null), []);
  useSocket({
    'display:state': (st) => {
      lastActivity.current = Date.now();
      setState((prev) => {
        if (prev.screen !== 'SUCCESS' && st.screen === 'SUCCESS') play('paymentSuccess');
        // session ended -> back to language selection
        if (st.screen === 'IDLE' && prev.screen !== 'IDLE') { setLocal(null); setConsented(false); if (s.languageSelect && s.returnToLanguageSelect) setLangChosen(false); }
        return st;
      });
    },
    'pair:closed': () => onUnpair(),
  }, { kind: 'display', token: localStorage.getItem(KEY) });

  // session timeout: no POS activity for N seconds while in a customer session
  useEffect(() => {
    const iv = setInterval(() => {
      if (state.screen !== 'IDLE' && Date.now() - lastActivity.current > (s.sessionTimeoutSec || 120) * 1000) {
        setState({ screen: 'IDLE' }); setLocal(null); setConsented(false); if (s.languageSelect && s.returnToLanguageSelect) setLangChosen(false);
      }
    }, 5000);
    return () => clearInterval(iv);
  }, [state.screen, s]);

  const needsPrivacy = s.privacyRequired && me.policies.length > 0 && !consented;
  const interactive = ['MEMBER_PROMPT', 'PHONE_INPUT', 'TAP_CARD'].includes(state.screen);
  const tapCard = async (v) => {
    if (state.screen !== 'TAP_CARD') return;
    play('tap');
    const r = await send('CARD', v);
    setLocal({ kind: 'CARD_RESULT', r });
  };
  useKeyboardWedge(tapCard, { enabled: state.screen === 'TAP_CARD', whenFocused: true });
  useCardReads(tapCard, state.screen === 'TAP_CARD');

  const playlist = s.playlistId;
  const promo = <SignagePlayer playlistId={playlist} lang={lang} fallback={<div className="fs-center" style={{ position: 'static', height: '100%', background: 'linear-gradient(135deg, var(--primary), var(--secondary))', color: '#fff' }}><div className="giant">{me.settings.storeName}</div><div className="huge">{t('welcome')}</div></div>} />;

  // 1) language selection — at the start of every customer session (idle screen keeps playing promotions)
  if (!langChosen && (state.screen !== 'IDLE' || local?.kind === 'LANG')) {
    return (
      <div className="fs"><div className="fs-center">
        <div className="huge">{LANGS.map((l) => l.code === 'th' ? 'เลือกภาษา' : l.code === 'zh' ? '选择语言' : 'Select language').join(' / ')}</div>
        <div className="grid g3" style={{ width: 'min(1000px, 94vw)' }}>{LANGS.map((l) => <Button key={l.code} size="xl" className="lang-btn" variant={l.code === (s.defaultLanguage || 'th') ? 'primary' : ''} onClick={() => { setLang(l.code); setLangChosen(true); setLocal(null); send('LANGUAGE', l.code); }}>{l.flag} {l.label}</Button>)}</div>
      </div></div>
    );
  }
  // 2) privacy consent before interaction
  if (needsPrivacy && (interactive || local?.kind === 'PRIVACY')) {
    return (
      <div className="fs"><div className="fs-center" style={{ justifyContent: 'flex-start', overflow: 'auto' }}>
        <ShieldCheck size={56} color="var(--primary)" /><div className="huge">{t('privacy.read')}</div>
        <div className="col" style={{ width: 'min(900px, 94vw)', textAlign: 'left' }}>{me.policies.map((p) => (
          <div key={p.id} className="card"><h3>{p.title?.[lang] || p.title?.en || p.kind} <span className="xs muted">v{p.version}</span></h3><div style={{ whiteSpace: 'pre-line', maxHeight: '28vh', overflow: 'auto' }}>{p.content?.[lang] || p.content?.en}</div></div>))}</div>
        <div className="row"><Button size="xl" onClick={() => { send('CANCEL'); setLocal(null); }}>{t('cancel')}</Button><Button size="xl" variant="primary" icon={CheckCircle2} onClick={() => { setConsented(true); setLocal(null); send('CONSENT', { policyIds: me.policies.map((p) => p.id), language: lang }); }}>{t('privacy.accept')}</Button></div>
      </div></div>
    );
  }

  const order = state.lines?.length > 0 || state.member || state.card;
  const pct = s.layout === 'SPLIT_60' ? 60 : s.layout === 'FULL' ? 100 : 50;
  const Overlay = ({ children }) => <div className="fs" style={{ zIndex: 5 }}><div className="fs-center slide-in">{children}</div></div>;

  return (
    <div className="fs" style={{ flexDirection: s.promotionSide === 'LEFT' ? 'row-reverse' : 'row', background: s.background ? `url(/api/public/media/${s.background}) center/cover` : undefined }}>
      {state.screen === 'IDLE' ? <div style={{ flex: 1, position: 'relative' }}>{promo}
        {!langChosen && <button type="button" onClick={() => setLocal({ kind: 'LANG' })} className="btn primary xl pill" style={{ position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)' }}>แตะเพื่อเริ่ม · Touch to start · 点击开始</button>}</div> : <>
        <div style={{ width: `${pct}%`, padding: '4vh 3vw', display: 'flex', flexDirection: 'column', gap: 16, background: 'var(--surface)', overflow: 'auto' }}>
          <div className="row between"><div className="huge">{me.settings.storeName}</div><div className="chips">{LANGS.map((l) => <button key={l.code} className={`chip ${lang === l.code ? 'active' : ''}`} onClick={() => { setLang(l.code); send('LANGUAGE', l.code); }}>{l.code.toUpperCase()}</button>)}</div></div>
          {state.member && <div className="card row"><UserRound /><div className="big">{t('member.hello', { name: state.member.name })}</div>{state.member.tier && <span className="badge primary">{state.member.tier}</span>}</div>}
          {state.card && <div className="card row between"><span className="row"><CreditCard /><span className="mono big">{state.card.number}</span></span><span><span className="muted">{t('currentBalance')} </span><b className="big num">{money(state.card.balance)}</b></span></div>}
          {state.screen === 'PAYMENT' ? (
            <div className="card center col" style={{ alignItems: 'center', flex: 1, justifyContent: 'center' }}>
              <div className="big">{t('pay.scan')} · {t('pay.promptpay')}</div>
              {state.qr && <QR value={state.qr} size={Math.min(380, window.innerHeight * 0.45)} />}
              <div className="muted">{t('pay.amount')}</div><div className="giant num">{money(state.total)}</div>
              <div className="row"><Loader2 style={{ animation: 'spin 1s linear infinite' }} /> {t('pay.waiting')}</div>
            </div>
          ) : order ? <>
            <div className="card" style={{ flex: 1 }}><h2>{t('order.summary')}</h2>
              {(state.lines || []).map((l, i) => <div key={i} className="row between big" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}><span>{l.name} {l.qty > 1 && `×${l.qty}`}{l.bonus > 0 && <span className="badge success"> +{money(l.bonus)} {t('bonus')}</span>}</span><span className="num">{money(l.total)}</span></div>)}
              {(state.lines || []).filter((l) => l.newBalance != null).map((l, i) => <div key={`nb${i}`} className="row between success"><span>{t('newBalance')}</span><b className="num big">{money(l.newBalance)}</b></div>)}
              {(state.promotions || []).map((p) => <div key={p} className="badge success">★ {p}</div>)}
            </div>
            {state.totals && <div className="card col">{state.totals.discount > 0 && <div className="row between"><span>{t('discount')}</span><span className="num">-{money(state.totals.discount)}</span></div>}
              {state.totals.vat > 0 && <div className="row between small muted"><span>{t('vat')}</span><span className="num">{money(state.totals.vat)}</span></div>}
              <div className="row between"><span className="huge">{t('total')}</span><span className="giant num">{money(state.totals.grandTotal)}</span></div></div>}
          </> : <div className="fs-center" style={{ position: 'static' }}><div className="huge">{t('welcome.to', { store: me.settings.storeName })}</div></div>}
        </div>
        {pct < 100 && <div style={{ flex: 1, minWidth: 0 }}>{promo}</div>}
      </>}

      {state.screen === 'MEMBER_PROMPT' && <Overlay><div className="giant">{t('member.ask')}</div><div className="row"><Button size="xl" variant="primary" className="lang-btn" onClick={() => { send('IS_MEMBER', true); setState((x) => ({ ...x, screen: 'PHONE_INPUT' })); }}>{t('yes')}</Button><Button size="xl" className="lang-btn" onClick={() => { send('IS_MEMBER', false); setState((x) => ({ ...x, screen: 'ORDER' })); }}>{t('no')}</Button></div></Overlay>}
      {state.screen === 'PHONE_INPUT' && !local && <Overlay><div className="huge">{t('phone.enter')}</div><PhonePad t={t} onSubmit={async (v) => { const r = await send('PHONE', v); setLocal({ kind: 'PHONE_RESULT', r }); }} /></Overlay>}
      {local?.kind === 'PHONE_RESULT' && state.screen === 'PHONE_INPUT' && <Overlay>{local.r?.found ? <><CheckCircle2 size={90} color="var(--success)" /><div className="giant">{t('member.found')}</div><div className="huge">{t('member.hello', { name: local.r.firstName })}</div></> : <><XCircle size={90} color="var(--danger)" /><div className="giant">{t('member.notFound')}</div><Button size="xl" onClick={() => setLocal(null)}>{t('retry')}</Button></>}</Overlay>}
      {state.screen === 'TAP_CARD' && <Overlay>{local?.kind === 'CARD_RESULT' && local.r?.cardId ? <><CheckCircle2 size={90} color="var(--success)" /><div className="huge mono">{local.r.cardNumber}</div><div className="big">{t('balance')}</div><div className="giant num">{money(local.r.balance)}</div></>
        : <><CreditCard size={120} className="pulse" color="var(--primary)" /><div className="giant">{t('card.tap')}</div><div className="big muted">{t('card.tapOrScan')}</div>{local?.r && !local.r.cardId && <div className="alert danger big">{t('err.cardNotFound')}</div>}</>}</Overlay>}
      {state.screen === 'MEMBER_NOT_FOUND' && <Overlay><XCircle size={90} color="var(--danger)" /><div className="giant">{t('member.notFound')}</div></Overlay>}
      {state.screen === 'ERROR' && <Overlay><XCircle size={90} color="var(--danger)" /><div className="giant">{t(ERROR_KEY[state.error] || 'err.generic')}</div></Overlay>}
      {state.screen === 'SUCCESS' && <Overlay><CheckCircle2 size={140} color="var(--success)" /><div className="giant">{t('pay.success')}</div>{state.total != null && <div className="huge num">{money(state.total)}</div>}
        {(state.lines || []).filter((l) => l.newBalance != null).map((l, i) => <div key={i} className="huge">{t('newBalance')}: <b className="num success">{money(l.newBalance)}</b></div>)}<div className="big">{t('thankyou')}</div></Overlay>}
    </div>
  );
}

export default function CustomerDisplay() {
  const [me, setMe] = useState(null);
  const [paired, setPaired] = useState(!!localStorage.getItem(KEY));
  const load = useCallback(async () => {
    try {
      const r = await client.get('/display/me');
      applyTheme(r.settings.theme); applyFont('display', r.settings.fonts); configureSounds(r.settings.sound, (id) => `/api/public/media/${id}`);
      setMe(r);
    } catch (e) { if (e.status === 401) { localStorage.removeItem(KEY); setPaired(false); } else setTimeout(load, 4000); }
  }, []);
  useEffect(() => { if (paired) load(); }, [paired, load]);
  if (!paired) return <Pair onPaired={() => setPaired(true)} />;
  if (!me) return <div className="fs"><div className="fs-center"><Loader2 size={60} style={{ animation: 'spin 1s linear infinite' }} /></div></div>;
  return <I18nProvider storageKey={null} initial={me.settings.display.defaultLanguage}><DisplayScreen me={me} onUnpair={() => { localStorage.removeItem(KEY); setPaired(false); setMe(null); }} /></I18nProvider>;
}

export { Input };
