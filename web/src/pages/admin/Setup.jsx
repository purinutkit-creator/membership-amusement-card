import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Button, Input } from '../../components/ui.jsx';

/** First-time owner creation, protected by the one-time setup token printed on the server console. */
export default function Setup() {
  const nav = useNavigate();
  const [status, setStatus] = useState(null);
  const [f, setF] = useState({ setupToken: '', firstName: '', lastName: '', email: '', username: '', password: '', password2: '', pin: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/auth/setup/status').then(setStatus); }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    setErr(null);
    if (f.password !== f.password2) return setErr('Passwords do not match');
    if (f.password.length < 10) return setErr('Password must be at least 10 characters');
    if (!/^[0-9]{4,6}$/.test(f.pin)) return setErr('PIN must be 4–6 digits');
    setBusy(true);
    try { await api.post('/auth/setup/owner', { ...f, password2: undefined }); nav('/login'); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  if (status?.hasOwner) return <div className="fs-center"><h2>Setup already completed</h2><Button variant="primary" onClick={() => nav('/login')}>Go to sign in</Button></div>;
  return (
    <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 16, background: 'linear-gradient(135deg, var(--primary), var(--secondary))' }}>
      <form className="card col" style={{ width: 'min(560px, 100%)' }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="row"><ShieldCheck color="var(--primary)" size={32} /><div><h2 style={{ margin: 0 }}>Create Owner account</h2><div className="muted small">The one-time setup token is printed in the server console at first start (or set via SETUP_TOKEN). Alternatively set OWNER_USERNAME / OWNER_PASSWORD env vars before first boot.</div></div></div>
        <Input label="Setup token *" value={f.setupToken} onChange={set('setupToken')} autoFocus />
        <div className="grid g2"><Input label="First name *" value={f.firstName} onChange={set('firstName')} /><Input label="Last name" value={f.lastName} onChange={set('lastName')} /></div>
        <Input label="Email" type="email" value={f.email} onChange={set('email')} />
        <Input label="Username *" value={f.username} onChange={set('username')} autoComplete="username" />
        <div className="grid g2"><Input label="Password * (min 10)" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" /><Input label="Confirm password *" type="password" value={f.password2} onChange={set('password2')} autoComplete="new-password" /></div>
        <Input label="PIN * (4–6 digits, for quick login & approvals)" inputMode="numeric" maxLength={6} value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })} />
        {err && <div className="alert danger">{err}</div>}
        <Button type="submit" variant="primary" size="lg" loading={busy}>Create owner</Button>
      </form>
    </div>
  );
}
