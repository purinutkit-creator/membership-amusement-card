// Full-screen Card Tap Terminal mounted at a machine / attraction.
// Never shows success before the server confirms the deduction; refuses taps while offline.
import { useCallback, useEffect, useRef, useState } from 'react';
import { WifiOff, CreditCard, CheckCircle2, XCircle, AlertTriangle, Coins, Stamp, Camera, Loader2 } from 'lucide-react';
import { tokenClient } from '../../lib/api.js';
import { getSocket, useSocket } from '../../lib/realtime.js';
import { useKeyboardWedge, useCardReads, ReaderManager } from '../../lib/readers.js';
import { I18nProvider, useI18n, LANGS, ERROR_KEY } from '../../lib/i18n.jsx';
import { applyTheme, applyFont } from '../../lib/theme.js';
import { configureSounds, play } from '../../lib/sound.js';
import { money } from '../../lib/format.js';
import { Button, Input } from '../../components/ui.jsx';
import { QR, CameraScanner } from '../../components/domain.jsx';

const TOKEN_KEY = 'sc.device.token';
const getToken = () => localStorage.getItem(TOKEN_KEY);
const client = tokenClient('Device', getToken);

export function Activate({ title = 'Activate device', onDone }) {
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const activate = async () => {
    setErr(null); setBusy(true);
    try { const r = await client.post('/devices/activate', { code, version: 'web-1.0' }); localStorage.setItem(TOKEN_KEY, r.token); onDone(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="fs"><div className="fs-center">
      <h1>{title}</h1><p className="muted">Ask an admin for a 6-digit activation code (Devices → Activate).</p>
      <form onSubmit={(e) => { e.preventDefault(); activate(); }} className="col" style={{ width: 'min(420px, 100%)' }}>
        <Input size="xl" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus placeholder="000000" aria-label="Activation code" />
        {err && <div className="alert danger">{err}</div>}
        <Button type="submit" variant="primary" size="xl" loading={busy} disabled={code.length !== 6}>Activate</Button>
      </form>
      <details className="small muted"><summary>Developer: paste device token</summary><div className="row mt-s"><Input value={token} onChange={(e) => setToken(e.target.value)} /><Button onClick={() => { localStorage.setItem(TOKEN_KEY, token.trim()); onDone(); }}>Use</Button></div></details>
    </div></div>
  );
}

function useOnline(connected) {
  const [net, setNet] = useState(navigator.onLine);
  useEffect(() => { const on = () => setNet(true); const off = () => setNet(false); window.addEventListener('online', on); window.addEventListener('offline', off); return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); }; }, []);
  return net && connected;
}

function TerminalScreen({ info, onRevoked, onReload }) {
  const { t, lang, setLang } = useI18n();
  const [state, setState] = useState({ screen: 'IDLE' });
  const [cam, setCam] = useState(false);
  const [count, setCount] = useState(0);
  const busy = useRef(false);
  const lastTap = useRef({ v: null, at: 0 });
  const timer = useRef(null);
  const auth = { kind: 'device', token: getToken() };
  const connected = useSocket({
    'play:allow': (e) => setState((s) => (s.screen === 'SUCCESS' ? { ...s, credits: e.credits } : s)),
    'device:revoked': () => onRevoked(),
    'machine:update': () => onReload(),
  }, auth);
  const online = useOnline(connected);
  const m = info.machine;

  useEffect(() => {
    const hb = setInterval(() => { client.post('/device/heartbeat', { version: 'web-1.0' }).catch(() => {}); getSocket(auth).emit('heartbeat'); }, (info.settings.heartbeatSec || 20) * 1000);
    return () => clearInterval(hb);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const back = useCallback((secs) => {
    clearInterval(timer.current);
    setCount(secs);
    timer.current = setInterval(() => setCount((c) => { if (c <= 1) { clearInterval(timer.current); setState({ screen: 'IDLE' }); return 0; } return c - 1; }), 1000);
  }, []);

  const tap = useCallback(async (ident) => {
    const v = String(ident || '').trim();
    if (!v || busy.current) return;
    if (!online) { play('error'); setState({ screen: 'ERROR', code: 'DEVICE_OFFLINE' }); back(3); return; }
    const cooldown = (info.settings.cooldownSec || 3) * 1000;
    if (lastTap.current.v === v && Date.now() - lastTap.current.at < cooldown && state.screen === 'SUCCESS') { play('error'); return; }
    busy.current = true;
    play('tap');
    setState({ screen: 'PROCESSING' });
    try {
      // The tap API answers rejections with {ok:false,result,...}; only server-confirmed APPROVED shows success.
      const res = await fetch('/api/tap', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Device ${getToken()}` },
        body: JSON.stringify({ machineId: m.id, cardIdentifier: v, requestId: crypto.randomUUID(), timestamp: new Date().toISOString(), deviceId: info.device.id }) });
      const r = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403 && r.error?.code === 'DEVICE_BLOCKED') { onRevoked(); return; }
      if (res.ok && r.result === 'APPROVED') {
        lastTap.current = { v, at: Date.now() };
        play(r.lowBalance ? 'lowBalance' : 'success');
        setState({ screen: 'SUCCESS', r });
        back(6);
      } else {
        const code = r.result || r.error?.code || 'ERROR';
        play(code === 'INSUFFICIENT_BALANCE' ? 'lowBalance' : 'error');
        setState({ screen: code === 'INSUFFICIENT_BALANCE' ? 'INSUFFICIENT' : 'ERROR', code, message: r.message || r.error?.message, details: r });
        back(code === 'INSUFFICIENT_BALANCE' ? 12 : 5);
      }
    } catch {
      play('error');
      setState({ screen: 'ERROR', code: 'DEVICE_OFFLINE' });
      back(4);
    } finally { busy.current = false; }
  }, [online, m, info, back, state.screen, onRevoked]);

  useKeyboardWedge(tap, { whenFocused: true });
  useCardReads(tap);
  useEffect(() => { ReaderManager.restore(); }, []);

  const bg = state.screen === 'SUCCESS' ? 'var(--success)' : state.screen === 'INSUFFICIENT' || state.screen === 'ERROR' ? 'var(--danger)' : undefined;
  return (
    <div className="fs" style={{ background: bg, color: bg ? '#fff' : undefined, transition: 'background .2s' }}>
      {!online && <div className="offline-bar"><WifiOff size={18} /> OFFLINE — {t('err.offline')}</div>}
      {state.screen === 'IDLE' && (
        <div className="fs-center slide-in">
          {m.imageMediaId ? <img src={`/api/public/media/${m.imageMediaId}`} alt="" style={{ maxHeight: '32vh', maxWidth: '80vw', borderRadius: 24, objectFit: 'contain' }} /> : <CreditCard size={120} color="var(--primary)" />}
          <div className="huge">{m.name}</div>
          <div className="big muted">{t('play.price')}: <b style={{ color: 'var(--primary)' }}>{m.freePlay ? 'FREE' : money(m.price)}</b>{m.memberPrice != null && <span className="small"> · member {money(m.memberPrice)}</span>}</div>
          <div className={`giant ${online ? 'pulse' : ''}`} style={{ color: online ? 'var(--primary)' : 'var(--danger)' }}>{online ? t('card.tapToPlay') : 'OFFLINE'}</div>
          {m.status !== 'AVAILABLE' && <div className="alert danger big">{t('err.machine')} ({m.status})</div>}
        </div>
      )}
      {state.screen === 'PROCESSING' && <div className="fs-center"><Loader2 size={120} style={{ animation: 'spin 1s linear infinite' }} /><div className="huge">{t('play.processing')}</div></div>}
      {state.screen === 'SUCCESS' && (
        <div className="fs-center slide-in">
          <CheckCircle2 size={140} />
          <div className="giant">{t('play.success')}</div>
          <div className="big">{state.r.machine.name}</div>
          <div className="grid g3" style={{ width: 'min(900px, 92vw)' }}>
            <div className="card" style={{ background: 'rgba(255,255,255,.15)', border: 0, color: '#fff' }}><div>{t('play.deducted')}</div><div className="huge num">{money(state.r.amount)}</div>{state.r.promotions?.length > 0 && <div className="small">★ {state.r.promotions.map((p) => p.name).join(', ')}</div>}</div>
            <div className="card" style={{ background: 'rgba(255,255,255,.15)', border: 0, color: '#fff' }}><div>{t('play.remaining')}</div><div className="huge num">{money(state.r.balance)}</div></div>
            <div className="card" style={{ background: 'rgba(255,255,255,.15)', border: 0, color: '#fff' }}><div><Coins size={18} /> +{state.r.pointsEarned} {t('points')}</div><div className="big"><Stamp size={18} /> +{state.r.stampsEarned} {t('stamps')}</div></div>
          </div>
          {state.r.member && <div className="big">{t('member.hello', { name: state.r.member.firstName })}</div>}
          {state.r.lowBalance && <div className="alert warning big">{t('balance')}: {money(state.r.balance)}</div>}
          <div className="muted" style={{ color: '#fff' }}>{t('session.timeout', { s: count })}</div>
        </div>
      )}
      {state.screen === 'INSUFFICIENT' && (
        <div className="fs-center slide-in">
          <XCircle size={120} />
          <div className="giant">{t('err.insufficient')}</div>
          <div className="row" style={{ gap: 40 }}><div><div className="big">{t('err.required')}</div><div className="huge num">{money(state.details?.required)}</div></div><div><div className="big">{t('balance')}</div><div className="huge num">{money(state.details?.balance)}</div></div></div>
          <div className="card center" style={{ background: '#fff', color: '#111' }}><QR value={`${location.origin}/m/topup`} size={180} /><div className="bold">{t('topup.scan')}</div></div>
          <div>{t('session.timeout', { s: count })}</div>
        </div>
      )}
      {state.screen === 'ERROR' && (
        <div className="fs-center slide-in"><AlertTriangle size={120} /><div className="giant">{t(ERROR_KEY[state.code] || 'err.generic')}</div>{!ERROR_KEY[state.code] && <div className="big">{state.message}</div>}<div>{t('session.timeout', { s: count })}</div></div>
      )}
      {state.screen === 'IDLE' && (
        <div className="row between" style={{ padding: 16 }}>
          <div className="chips">{LANGS.map((l) => <button key={l.code} className={`chip ${lang === l.code ? 'active' : ''}`} onClick={() => setLang(l.code)}>{l.flag} {l.label}</button>)}</div>
          <div className="row small muted"><span className={`dot ${online ? 'on' : 'off'}`} /> {info.device.code} <Button size="sm" variant="ghost" icon={Camera} onClick={() => setCam(true)} aria-label="Scan QR" /></div>
        </div>
      )}
      <CameraScanner open={cam} onClose={() => setCam(false)} onResult={(v) => { setCam(false); tap(v); }} />
    </div>
  );
}

export default function Terminal() {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState(null);
  const [needsActivation, setNeeds] = useState(!getToken());
  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await client.get('/device/me');
      applyTheme(r.settings.theme); applyFont('terminal', r.settings.fonts); configureSounds(r.settings.sound, (id) => `/api/public/media/${id}`);
      setInfo(r);
    } catch (e) { if (e.status === 401 || e.status === 403) { localStorage.removeItem(TOKEN_KEY); setNeeds(true); } else setErr(e); }
  }, []);
  useEffect(() => { if (!needsActivation) load(); }, [needsActivation, load]);
  useEffect(() => { if (err) { const t = setTimeout(load, 5000); return () => clearTimeout(t); } return undefined; }, [err, load]);
  if (needsActivation) return <Activate title="Activate Card Terminal" onDone={() => setNeeds(false)} />;
  if (err) return <div className="fs"><div className="offline-bar">OFFLINE</div><div className="fs-center"><WifiOff size={100} color="var(--danger)" /><div className="huge">OFFLINE</div><div className="muted">Reconnecting…</div></div></div>;
  if (!info) return <div className="fs"><div className="fs-center"><Loader2 size={60} style={{ animation: 'spin 1s linear infinite' }} /></div></div>;
  if (!info.machine) return <div className="fs"><div className="fs-center"><h1>{info.device.name}</h1><div className="alert warning">This terminal is not linked to a machine. In admin: Machines → edit → Reader / terminal device.</div><Button onClick={load}>Retry</Button></div></div>;
  return <I18nProvider storageKey="sc.terminal.lang"><TerminalScreen info={info} onReload={load} onRevoked={() => { localStorage.removeItem(TOKEN_KEY); setNeeds(true); }} /></I18nProvider>;
}
