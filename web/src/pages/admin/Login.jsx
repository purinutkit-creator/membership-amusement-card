import { useEffect, useState } from 'react';
import { AdminLangToggle } from '../../lib/adminI18n.jsx';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { LogIn, KeyRound, User } from 'lucide-react';
import { useAuth } from '../../lib/auth.jsx';
import { api } from '../../lib/api.js';
import { Button, Input, Tabs } from '../../components/ui.jsx';
import { PinPad } from '../../components/Layout.jsx';

export default function Login() {
  const { login, staff, settings } = useAuth();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [tab, setTab] = useState('pin');
  const [f, setF] = useState({ username: '', password: '', employeeCode: '', pin: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  useEffect(() => { api.get('/auth/setup/status').then(setStatus).catch(() => {}); }, []);
  useEffect(() => { if (staff) nav(sp.get('next') || '/', { replace: true }); }, [staff]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async (pinOverride) => {
    setErr(null); setBusy(true);
    try {
      if (tab === 'pin') await login({ employeeCode: f.employeeCode.trim(), pin: pinOverride ?? f.pin });
      else await login({ username: f.username.trim(), password: f.password });
    } catch (e) { setErr(e.message); setF((s) => ({ ...s, pin: '' })); } finally { setBusy(false); }
  };
  const bg = settings?.branding?.loginBgMediaId ? `url(/api/public/media/${settings.branding.loginBgMediaId}) center/cover` : 'linear-gradient(135deg, var(--primary), var(--secondary))';
  const logo = settings?.branding?.logoMediaId ? `/api/public/media/${settings.branding.logoMediaId}` : null;
  return (
    <div style={{ minHeight: '100%', background: bg, display: 'grid', placeItems: 'center', padding: 16 }}>
      <div className="card" style={{ width: 'min(420px, 100%)', padding: 28 }}>
        <div className="center col" style={{ alignItems: 'center', marginBottom: 12 }}>
          {logo ? <img src={logo} alt="" style={{ maxHeight: 64, maxWidth: 200 }} /> : <img src="/icon.svg" alt="" width={56} />}
          <h1 style={{ marginTop: 8 }}>{settings?.general?.storeName || 'Smart Card Platform'}</h1>
          <div className="muted">Staff sign in</div>
        </div>
        {status && !status.hasOwner && <div className="alert warning mb">No owner account yet. <Link to="/setup">Run first-time setup →</Link></div>}
        <Tabs tabs={[{ value: 'pin', label: 'Employee code + PIN' }, { value: 'password', label: 'Username + Password' }]} value={tab} onChange={(t) => { setTab(t); setErr(null); }} />
        <form className="col" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          {tab === 'pin' ? <>
            <Input label="Employee code" value={f.employeeCode} onChange={(e) => setF({ ...f, employeeCode: e.target.value.toUpperCase() })} autoFocus autoComplete="username" size="lg" />
            <PinPad value={f.pin} onChange={(pin) => setF({ ...f, pin })} onSubmit={(pin) => f.employeeCode && submit(pin)} />
          </> : <>
            <Input label="Username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoFocus autoComplete="username" size="lg" />
            <Input label="Password" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="current-password" size="lg" />
          </>}
          {err && <div className="alert danger">{err}</div>}
          <Button type="submit" variant="primary" size="lg" block icon={tab === 'pin' ? KeyRound : LogIn} loading={busy}
            disabled={tab === 'pin' ? !f.employeeCode || f.pin.length < 4 : !f.username || !f.password}>Sign in</Button>
        </form>
        <div className="row between mt small"><Link to="/m"><User size={14} /> Member portal</Link><Link to="/terminal">Card terminal</Link><Link to="/display">Customer display</Link></div>
        <div className="row center mt"><AdminLangToggle /></div>
      </div>
    </div>
  );
}
