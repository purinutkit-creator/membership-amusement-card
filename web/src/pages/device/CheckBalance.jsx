// CHECK CARD BALANCE kiosk (activated KIOSK device). Tap / scan barcode / scan QR / type number.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CreditCard, Camera, Search, Loader2, AlertTriangle } from 'lucide-react';
import { tokenClient } from '../../lib/api.js';
import { useKeyboardWedge, useCardReads } from '../../lib/readers.js';
import { I18nProvider, useI18n, LanguageSwitcher, ERROR_KEY } from '../../lib/i18n.jsx';
import { applyTheme, applyFont } from '../../lib/theme.js';
import { money, int, date } from '../../lib/format.js';
import { play } from '../../lib/sound.js';
import { Button, Input } from '../../components/ui.jsx';
import { CameraScanner, QR } from '../../components/domain.jsx';
import { Activate } from './Terminal.jsx';

const KEY = 'sc.device.token';
const client = tokenClient('Device', () => localStorage.getItem(KEY));

function Kiosk({ onRevoked }) {
  const { t } = useI18n();
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [num, setNum] = useState('');
  const [cam, setCam] = useState(false);
  const timer = useRef(null);
  const check = useCallback(async (v) => {
    if (!v || busy) return;
    setBusy(true); setErr(null); play('tap');
    try { setRes(await client.post('/device/balance', { cardIdentifier: v })); play('success'); } catch (e) { if (e.status === 401) onRevoked(); setErr(e.code); setRes(null); play('error'); } finally { setBusy(false); setNum(''); }
    clearTimeout(timer.current); timer.current = setTimeout(() => { setRes(null); setErr(null); }, 15000);
  }, [busy, onRevoked]);
  useKeyboardWedge(check);
  useCardReads(check);
  return (
    <div className="fs">
      <div className="row between" style={{ padding: 16 }}><b className="big">{t('balance.check')}</b><LanguageSwitcher /></div>
      <div className="fs-center">
        {busy ? <Loader2 size={80} style={{ animation: 'spin 1s linear infinite' }} /> : res ? (
          <div className="col slide-in" style={{ width: 'min(760px, 94vw)' }}>
            <div className="dcard" style={{ minHeight: 220 }}><div className="row between" style={{ zIndex: 1 }}><span className="mono big">{res.cardNumber}</span><span className="badge" style={{ background: 'rgba(255,255,255,.25)', color: '#fff' }}>{res.status}</span></div>
              <div style={{ zIndex: 1 }}><div>{t('balance')}</div><div className="giant num">{money(res.balance)}</div></div>
              <div className="row between" style={{ zIndex: 1 }}><span>{res.member ? t('member.hello', { name: res.member.firstName }) : 'Guest'}</span><span>{res.member?.tier && `${t('tier')}: ${res.member.tier}`}</span></div></div>
            <div className="grid g3"><div className="card center"><div className="muted">{t('points')}</div><div className="huge num">{int(res.points)}</div></div><div className="card center"><div className="muted">{t('stamps')}</div><div className="huge num">{int(res.stamps)}</div></div><div className="card center"><div className="muted">{t('expires')}</div><div className="big">{res.expiresAt ? date(res.expiresAt) : '—'}</div></div></div>
            <div className="card row between"><span className="big">{t('topup.scan')}</span><QR value={`${location.origin}/m/topup`} size={110} /></div>
            <Button size="xl" onClick={() => setRes(null)}>{t('done')}</Button>
          </div>
        ) : <>
          <CreditCard size={120} className="pulse" color="var(--primary)" />
          <div className="giant">{t('card.tapOrScan')}</div>
          {err && <div className="alert danger big"><AlertTriangle /> {t(ERROR_KEY[err] || 'err.generic')}</div>}
          <form className="row" onSubmit={(e) => { e.preventDefault(); check(num); }} style={{ width: 'min(620px, 94vw)' }}>
            <Input className="grow" size="lg" inputMode="numeric" placeholder={t('card.enterNumber')} value={num} onChange={(e) => setNum(e.target.value.replace(/[^0-9]/g, '').slice(0, 12))} />
            <Button size="lg" type="submit" variant="primary" icon={Search} disabled={num.length !== 12}>{t('confirm')}</Button>
            <Button size="lg" icon={Camera} onClick={() => setCam(true)} aria-label="QR" />
          </form>
        </>}
      </div>
      <CameraScanner open={cam} onClose={() => setCam(false)} onResult={(v) => { setCam(false); check(v); }} />
    </div>
  );
}

export default function CheckBalance() {
  const [ok, setOk] = useState(!!localStorage.getItem(KEY));
  useEffect(() => { if (ok) client.get('/device/me').then((r) => { applyTheme(r.settings.theme); applyFont('terminal', r.settings.fonts); }).catch((e) => { if (e.status === 401) { localStorage.removeItem(KEY); setOk(false); } }); }, [ok]);
  if (!ok) return <Activate title="Activate Balance Kiosk" onDone={() => setOk(true)} />;
  return <I18nProvider storageKey="sc.kiosk.lang"><Kiosk onRevoked={() => { localStorage.removeItem(KEY); setOk(false); }} /></I18nProvider>;
}
