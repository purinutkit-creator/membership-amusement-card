import { useState } from 'react';
import { KeyRound, ShieldCheck, Unlock } from 'lucide-react';
import { api } from '../../lib/api.js';
import { dt, date } from '../../lib/format.js';
import { EntityPage } from '../../components/entity.jsx';
import { Button, Badge, StatusBadge, useLoad, Modal, Input, useAction, Table } from '../../components/ui.jsx';
import { mediaSrc } from '../../components/domain.jsx';
import { useAuth } from '../../lib/auth.jsx';

function Overrides({ staff, onClose }) {
  const cat = useLoad(() => api.get('/permissions'), []);
  const cur = useLoad(() => api.get(`/staff/${staff.id}`), [staff.id]);
  const roles = useLoad(() => api.get('/roles'), []);
  const [ov, setOv] = useState(null);
  const [run, busy] = useAction();
  if (!cat.data || !cur.data || !roles.data) return null;
  const state = ov || Object.fromEntries(cur.data.overrides.map((o) => [o.permission_code, o.effect]));
  const rolePerms = new Set(roles.data.items.find((r) => r.id === staff.role_id)?.permissions || []);
  const cycle = (code) => setOv({ ...state, [code]: state[code] === 'GRANT' ? 'DENY' : state[code] === 'DENY' ? undefined : 'GRANT' });
  return (
    <Modal open title={`Permission overrides — ${staff.first_name}`} size="xwide" onClose={onClose} footer={<Button variant="primary" loading={busy} onClick={() => run(() => api.put(`/staff/${staff.id}/permissions`, { overrides: Object.entries(state).filter(([, e]) => e).map(([code, effect]) => ({ code, effect })) }), { success: 'Permissions saved' }).then(onClose)}>Save</Button>}>
      <div className="small muted mb">Role <b>{staff.role_name}</b> grants the ticked permissions. Click to cycle: inherit → <Badge tone="success">GRANT</Badge> → <Badge tone="danger">DENY</Badge>.</div>
      <div className="grid g3">{Object.entries(cat.data.catalog).map(([mod, actions]) => (
        <div key={mod} className="card tight"><b className="small">{mod}</b>{Object.entries(actions).map(([a, label]) => { const code = `${mod}.${a}`; const eff = state[code]; return (
          <button key={code} type="button" onClick={() => cycle(code)} className="row between" style={{ width: '100%', background: 'none', border: 0, padding: '4px 0', cursor: 'pointer', color: 'inherit', font: 'inherit', textAlign: 'left' }} title={code}>
            <span className="xs">{rolePerms.has(code) ? '✓' : '·'} {label}</span>{eff && <Badge tone={eff === 'GRANT' ? 'success' : 'danger'}>{eff}</Badge>}</button>); })}</div>))}</div>
    </Modal>
  );
}

function Reset({ staff, onClose }) {
  const [pin, setPin] = useState('');
  const [pw, setPw] = useState('');
  const [run, busy] = useAction();
  return (
    <Modal open title={`Reset credentials — ${staff.first_name}`} onClose={onClose} footer={<Button variant="primary" loading={busy} disabled={!pin && !pw} onClick={() => run(() => api.post(`/staff/${staff.id}/reset-credentials`, { pin: pin || undefined, password: pw || undefined }), { success: 'Credentials reset — sessions signed out' }).then(onClose)}>Reset</Button>}>
      <div className="col"><Input label="New PIN (4–6 digits)" type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /><Input label="New password (min 10, requires username)" type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
    </Modal>
  );
}

export default function Staff() {
  const { can, staff: me } = useAuth();
  const roles = useLoad(() => api.get('/roles').catch(() => ({ items: [] })), []);
  const branches = useLoad(() => api.get('/branches'), []);
  const merchants = useLoad(() => api.get('/merchants').catch(() => ({ items: [] })), []);
  const [ov, setOv] = useState(null);
  const [reset, setReset] = useState(null);
  const [run] = useAction();
  const roleOpts = (roles.data?.items || []).filter((r) => me?.isOwner || !['OWNER', 'SUPER_ADMIN'].includes(r.code)).map((r) => ({ value: r.id, label: r.name }));
  return (
    <>
      <EntityPage title="Staff" subtitle="Employees, roles, PIN / password login, branch, discount limits" path="/staff" managePerm="staff.edit" singular="staff member" deleteLabel="Delete staff"
        filters={[{ name: 'roleId', label: 'Role', options: roleOpts }, { name: 'status', label: 'Status', options: ['ACTIVE', 'SUSPENDED'] }]}
        extraActions={(r, reload) => !r.is_owner || me?.isOwner ? <>
          {can('staff.reset_credentials') && <Button size="sm" icon={KeyRound} onClick={() => setReset(r)}>Reset</Button>}
          {r.locked_until && new Date(r.locked_until) > new Date() && can('staff.reset_credentials') && <Button size="sm" icon={Unlock} onClick={() => run(() => api.post(`/staff/${r.id}/reset-credentials`, { unlock: true }), { success: 'Unlocked' }).then(reload)}>Unlock</Button>}
          {can('staff.permission') && !r.is_owner && <Button size="sm" icon={ShieldCheck} onClick={() => setOv(r)}>Permissions</Button>}</> : null}
        columns={[{ label: '', render: (r) => r.profile_media_id ? <img src={mediaSrc(r.profile_media_id)} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} /> : <span className="logo" style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--surface-2)', display: 'grid', placeItems: 'center', fontWeight: 700 }}>{r.first_name[0]}</span> },
          { label: 'Name', render: (r) => <><b>{r.first_name} {r.last_name}</b>{r.nickname && ` (${r.nickname})`}{r.is_owner && <Badge tone="primary">OWNER</Badge>}<div className="xs muted">{r.email} {r.phone}</div></> },
          { label: 'Code / username', render: (r) => <><code>{r.employee_code}</code><div className="xs muted">{r.username || '—'}</div></> }, { key: 'role_name', label: 'Role' }, { key: 'branch_name', label: 'Branch' },
          { label: 'Max discount', num: true, render: (r) => (r.max_discount_pct != null ? `${r.max_discount_pct}%` : 'role') }, { label: 'Last login', render: (r) => <span className="xs">{dt(r.last_login_at)}</span> },
          { label: 'Status', render: (r) => <><StatusBadge status={r.status} />{r.locked_until && new Date(r.locked_until) > new Date() && <Badge tone="danger">LOCKED</Badge>}</> }]}
        fields={(row) => [
          { name: 'employeeCode', label: 'Employee code', required: true, upper: true }, { name: 'firstName', label: 'First name', required: true }, { name: 'lastName', label: 'Last name' }, { name: 'nickname', label: 'Nickname' },
          { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email' }, { name: 'profileMediaId', label: 'Profile image', type: 'media', category: 'GENERAL' },
          { name: 'roleId', label: 'Role', type: 'select', required: true, options: roleOpts }, { name: 'branchId', label: 'Branch', type: 'select', options: (branches.data?.items || []).map((b) => ({ value: b.id, label: b.name })) },
          { name: 'merchantId', label: 'Food Park merchant (POS scope)', type: 'select', options: (merchants.data?.items || []).map((m) => ({ value: m.id, label: m.name })) },
          { name: 'username', label: 'Username (for password login)' }, ...(row?.id ? [] : [{ name: 'password', label: 'Password (min 10)', type: 'password' }, { name: 'pin', label: 'PIN (4–6 digits)', type: 'password', pattern: /^(\d{4,6})?$/, patternMessage: 'PIN must be 4–6 digits' }]),
          { name: 'maxDiscountPct', label: 'Max discount % (blank = role default)', type: 'number', min: 0 }, { name: 'startDate', label: 'Start date', type: 'date' },
          { name: 'status', label: 'Status', type: 'select', options: ['ACTIVE', 'SUSPENDED'].map((v) => ({ value: v, label: v })) }, { name: 'note', label: 'Note', type: 'textarea', full: true }]}
        defaults={{ status: 'ACTIVE' }}
        toForm={(r) => ({ employeeCode: r.employee_code, firstName: r.first_name, lastName: r.last_name, nickname: r.nickname, phone: r.phone, email: r.email, profileMediaId: r.profile_media_id, roleId: r.role_id, branchId: r.branch_id, merchantId: r.merchant_id, username: r.username, maxDiscountPct: r.max_discount_pct, startDate: r.start_date ? date(r.start_date) && String(r.start_date).slice(0, 10) : '', status: r.status, note: r.note })}
        toPayload={(f) => ({ ...f, maxDiscountPct: f.maxDiscountPct === '' || f.maxDiscountPct == null ? null : Number(f.maxDiscountPct), branchId: f.branchId || null, merchantId: f.merchantId || null, profileMediaId: f.profileMediaId || null, lastName: f.lastName || '', email: f.email || '', username: f.username || '', startDate: f.startDate || '' })} />
      {ov && <Overrides staff={ov} onClose={() => setOv(null)} />}
      {reset && <Reset staff={reset} onClose={() => setReset(null)} />}
      <span hidden><Table columns={[]} rows={[]} /></span>
    </>
  );
}
