import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CreditCard, Lock } from 'lucide-react';
import { api } from '../../lib/api.js';
import { I18nProvider, useI18n, LanguageSwitcher } from '../../lib/i18n.jsx';
import { applyPublicSettings } from '../../lib/auth.jsx';
import { Button, Input, useLoad } from '../../components/ui.jsx';

/** Card QR landing: secure random token only identifies the card; the member must verify with their PIN. */
function Inner() {
  const { token } = useParams();
  const { t } = useI18n();
  const nav = useNavigate();
  const st = useLoad(() => api.get(`/public/card-portal/${token}`), [token]);
  const [pin, setPin] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/public/settings').then((s) => applyPublicSettings(s, 'member')).catch(() => {}); }, []);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { const r = await api.post('/member/card-login', { token, pin }, { approval: false }); nav(`/m/card/${r.focusCardId}`); } catch (e) { setErr(e.message); setPin(''); } finally { setBusy(false); }
  };
  return (
    <div className="fs"><div className="row between" style={{ padding: 12 }}><span /><LanguageSwitcher compact /></div><div className="fs-center">
      {st.error ? <div className="alert danger big">{st.error.message}</div> : !st.data ? null : <>
        <CreditCard size={72} color="var(--primary)" /><div className="huge mono">{st.data.cardMasked}</div>
        {st.data.hasMember ? <form className="col" style={{ width: 'min(380px, 92vw)' }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="muted"><Lock size={14} /> {t('portal.cardLogin')}</div>
          <Input size="xl" type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} autoFocus aria-label="PIN" />
          {err && <div className="alert danger">{err}</div>}
          <Button type="submit" variant="primary" size="xl" loading={busy} disabled={pin.length !== 6}>{t('confirm')}</Button>
        </form> : <div className="alert">{t('portal.noCard')}</div>}
      </>}
    </div></div>
  );
}
export default function CardPortal() { return <I18nProvider><Inner /></I18nProvider>; }
