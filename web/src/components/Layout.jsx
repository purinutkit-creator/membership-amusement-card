import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Crown, ShoppingCart, Users, CreditCard, Wallet, ArrowLeftRight, Gamepad2, MonitorSmartphone, Stamp, Coins, Gift, Megaphone, Package,
  MonitorPlay, Tv, Cpu, Printer, UserCog, ShieldCheck, Building2, BarChart3, ScrollText, Images, Settings as SettingsIcon, Menu, Search, Bell, Moon, Sun,
  Lock, LogOut, Repeat, Receipt, Clock, Delete, Wifi, WifiOff, Store,
} from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { api, setBranch, getBranch } from '../lib/api.js';
import { toggleMode } from '../lib/theme.js';
import { useSocket } from '../lib/realtime.js';
import { Button, Input, Modal, useDebounced, useToast, Badge } from './ui.jsx';
import { dt } from '../lib/format.js';

export const MENU = [
  { sec: 'Overview' },
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, perm: 'dashboard.view', end: true },
  { to: '/owner', label: 'Owner Dashboard', icon: Crown, perm: 'dashboard.owner' },
  { sec: 'Front Desk' },
  { to: '/pos', label: 'POS / Cashier', icon: ShoppingCart, perm: 'pos.open' },
  { to: '/topup', label: 'Top Up', icon: Wallet, perm: 'topup.create' },
  { to: '/members', label: 'Members', icon: Users, perm: 'member.view' },
  { to: '/cards', label: 'Cards', icon: CreditCard, perm: 'card.view' },
  { to: '/stamps', label: 'M-Stamp', icon: Stamp, perm: 'stamp.add' },
  { to: '/points', label: 'Points', icon: Coins, perm: 'point.add' },
  { to: '/rewards', label: 'Rewards', icon: Gift, any: ['reward.view', 'reward.redeem'] },
  { to: '/orders', label: 'Orders & Receipts', icon: Receipt, any: ['pos.open', 'transaction.view'] },
  { to: '/shifts', label: 'Cashier Shifts', icon: Clock, any: ['pos.shift', 'report.view'] },
  { to: '/transactions', label: 'Transactions', icon: ArrowLeftRight, perm: 'transaction.view' },
  { sec: 'Play & Sell' },
  { to: '/machines', label: 'Machines / Attractions', icon: Gamepad2, perm: 'machine.view' },
  { to: '/terminals', label: 'Card Terminals', icon: MonitorSmartphone, any: ['device.view', 'machine.view'] },
  { to: '/promotions', label: 'Promotions', icon: Megaphone, any: ['promotion.view', 'promotion.manage'] },
  { to: '/products', label: 'Products & Food Park', icon: Package, any: ['product.view', 'merchant.view'] },
  { sec: 'Displays & Devices' },
  { to: '/customer-displays', label: 'Customer Displays', icon: MonitorPlay, any: ['display.manage', 'pos.open'] },
  { to: '/promotion-displays', label: 'Promotion Displays', icon: Tv, perm: 'display.manage' },
  { to: '/devices', label: 'Devices', icon: Cpu, any: ['device.view', 'device.manage'] },
  { to: '/printers', label: 'Printers', icon: Printer, any: ['printer.manage', 'pos.open'] },
  { to: '/media', label: 'Media Library', icon: Images, any: ['media.manage', 'display.manage'] },
  { sec: 'Administration' },
  { to: '/staff', label: 'Staff', icon: UserCog, perm: 'staff.view' },
  { to: '/roles', label: 'Roles & Permissions', icon: ShieldCheck, perm: 'staff.permission' },
  { to: '/branches', label: 'Branches', icon: Building2, perm: 'branch.manage' },
  { to: '/reports', label: 'Reports', icon: BarChart3, perm: 'report.view' },
  { to: '/audit', label: 'Audit Logs', icon: ScrollText, perm: 'audit.view' },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, perm: 'settings.view' },
];

function GlobalSearch() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const [res, setRes] = useState([]);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const nav = useNavigate();
  useEffect(() => { if (dq.length < 2) { setRes([]); return; } api.get(`/search?q=${encodeURIComponent(dq)}`).then((r) => { setRes(r.results); setSel(0); }).catch(() => setRes([])); }, [dq]);
  const go = (r) => {
    const map = { member: `/members/${r.id}`, card: `/cards/${r.id}`, transaction: `/transactions/${r.id}`, receipt: `/orders?receipt=${r.id}`, order: `/orders/${r.id}`, reward: '/rewards', machine: '/machines', redemption: '/rewards?tab=counter' };
    nav(map[r.kind]); setQ(''); setOpen(false);
  };
  return (
    <div className="search-box">
      <Search size={18} />
      <input className="input" placeholder="Search member, phone, card, transaction, receipt, reward, machine…" value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 200)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') setSel((s) => Math.min(s + 1, res.length - 1)); if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1)); if (e.key === 'Enter' && res[sel]) go(res[sel]); }} aria-label="Global search" />
      {open && res.length > 0 && (
        <div className="search-results">{res.map((r, i) => (
          <a key={`${r.kind}${r.id}`} href="#" className={i === sel ? 'sel' : ''} onMouseDown={(e) => { e.preventDefault(); go(r); }}>
            <Badge tone="primary">{r.kind}</Badge><div className="grow"><div className="bold">{r.title}</div><div className="xs muted">{r.subtitle}</div></div></a>))}</div>
      )}
    </div>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({ items: [], unread: 0 });
  const toast = useToast();
  const load = () => api.get('/notifications').then(setData).catch(() => {});
  useEffect(() => { load(); }, []);
  useSocket({ 'notification:new': (n) => { load(); if (n.audience !== 'MEMBER') toast.info(n.title); } });
  return (
    <>
      <Button variant="ghost" icon={Bell} onClick={() => setOpen(true)} aria-label="Notifications">{data.unread > 0 && <Badge tone="danger">{data.unread}</Badge>}</Button>
      <Modal open={open} title="Notifications" onClose={() => setOpen(false)} footer={<Button onClick={async () => { await api.post('/notifications/read', { all: true }); load(); }}>Mark all read</Button>}>
        {data.items.length === 0 ? <div className="muted">No notifications</div> : data.items.map((n) => (
          <div key={n.id} className="row top" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', opacity: n.read ? 0.6 : 1 }}>
            <Badge tone={/OFFLINE|BLOCK|LOW/.test(n.type) ? 'warning' : 'info'}>{n.type}</Badge>
            <div className="grow"><div className="bold">{n.title}</div>{n.body && <div className="small muted">{n.body}</div>}<div className="xs faint">{dt(n.created_at)}</div></div>
          </div>
        ))}
      </Modal>
    </>
  );
}

function PinPad({ value, onChange, onSubmit, max = 6 }) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'del'];
  return (
    <div className="col">
      <div className="center huge mono" style={{ letterSpacing: '.4em', minHeight: 56 }}>{'•'.repeat(value.length) || <span className="faint small">Enter PIN</span>}</div>
      <div className="keypad">{keys.map((k) => <button key={k} type="button" onClick={() => {
        if (k === 'clear') onChange(''); else if (k === 'del') onChange(value.slice(0, -1)); else if (value.length < max) { const v = value + k; onChange(v); if (v.length === max) onSubmit?.(v); }
      }}>{k === 'del' ? <Delete /> : k === 'clear' ? 'C' : k}</button>)}</div>
    </div>
  );
}
export { PinPad };

function LockScreen() {
  const { staff, unlock, switchStaff, logout } = useAuth();
  const [pin, setPin] = useState('');
  const [mode, setMode] = useState('unlock');
  const [code, setCode] = useState('');
  const [err, setErr] = useState(null);
  const submit = async (p = pin) => {
    setErr(null);
    try { if (mode === 'unlock') await unlock(p); else await switchStaff(code, p); } catch (e) { setErr(e.message); setPin(''); }
  };
  return (
    <div className="modal-bg" style={{ background: 'color-mix(in srgb, var(--bg) 92%, transparent)', backdropFilter: 'blur(10px)' }}>
      <div className="card" style={{ width: 'min(380px, 100%)' }}>
        <div className="center col" style={{ alignItems: 'center' }}><Lock size={36} color="var(--primary)" />
          <h2>{mode === 'unlock' ? `Locked — ${staff?.firstName}` : 'Switch staff'}</h2></div>
        {mode === 'switch' && <Input label="Employee code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoFocus />}
        {err && <div className="alert danger mt-s">{err}</div>}
        <div className="mt"><PinPad value={pin} onChange={setPin} onSubmit={(v) => v.length >= 4 && submit(v)} /></div>
        <Button variant="primary" block className="mt" disabled={pin.length < 4} onClick={() => submit()}>{mode === 'unlock' ? 'Unlock' : 'Switch'}</Button>
        <div className="row between mt">
          <Button variant="ghost" icon={Repeat} onClick={() => { setMode(mode === 'unlock' ? 'switch' : 'unlock'); setPin(''); setErr(null); }}>{mode === 'unlock' ? 'Switch staff' : 'Back to unlock'}</Button>
          <Button variant="ghost" icon={LogOut} onClick={logout}>Sign out</Button>
        </div>
      </div>
    </div>
  );
}

function BranchSwitcher() {
  const { staff, can, refresh } = useAuth();
  const [branches, setBranches] = useState([]);
  useEffect(() => { api.get('/branches').then((r) => setBranches(r.items)).catch(() => {}); }, []);
  if (!(staff?.isOwner || can('branch.manage')) || branches.length < 2) return null;
  return (
    <select className="input hide-mobile" style={{ width: 180 }} value={getBranch()} onChange={(e) => { setBranch(e.target.value); refresh(); window.location.reload(); }} aria-label="Branch">
      <option value="">My branch</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
    </select>
  );
}

export default function Layout() {
  const { staff, settings, can, canAny, lock, logout, locked } = useAuth();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(document.documentElement.dataset.theme);
  const loc = useLocation();
  const connected = useSocket({});
  useEffect(() => setOpen(false), [loc.pathname]);
  const items = MENU.filter((m) => m.sec || (m.perm ? can(m.perm) : m.any ? canAny(...m.any) : true));
  const visible = items.filter((m, i) => !m.sec || (items[i + 1] && !items[i + 1].sec));
  const logo = settings?.branding?.logoMediaId ? `/api/public/media/${settings.branding.logoMediaId}` : null;
  return (
    <div className="shell">
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <aside className={`sidebar no-print ${open ? 'open' : ''}`} aria-label="Main navigation">
        <div className="brand">{logo ? <img src={logo} alt="" /> : <span className="logo"><Store size={18} /></span>}<span>{settings?.general?.storeName}</span></div>
        {visible.map((m, i) => m.sec ? <div key={`s${i}`} className="nav-sec">{m.sec}</div> : (
          <NavLink key={m.to} to={m.to} end={m.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}><m.icon size={18} />{m.label}</NavLink>
        ))}
      </aside>
      <div className="main">
        <header className="topbar no-print">
          <Button variant="ghost" icon={Menu} className="menu-btn" onClick={() => setOpen(true)} aria-label="Open menu" />
          <GlobalSearch />
          <div className="grow" />
          <span title={connected ? 'Realtime connected' : 'Realtime disconnected'}>{connected ? <Wifi size={18} color="var(--success)" /> : <WifiOff size={18} color="var(--danger)" />}</span>
          <BranchSwitcher />
          <Notifications />
          <Button variant="ghost" icon={mode === 'dark' ? Sun : Moon} onClick={() => setMode(toggleMode(settings?.theme))} aria-label="Toggle dark mode" />
          <Button variant="ghost" icon={Lock} onClick={lock} aria-label="Lock screen" />
          <div className="hide-mobile small right"><div className="bold">{staff?.firstName} {staff?.lastName}</div><div className="xs muted">{staff?.roleName}</div></div>
          <Button variant="ghost" icon={LogOut} onClick={logout} aria-label="Sign out" />
        </header>
        <main className="content"><Outlet /></main>
      </div>
      {locked && <LockScreen />}
    </div>
  );
}

export function useIsMounted() { const r = useRef(true); useEffect(() => () => { r.current = false; }, []); return r; }
