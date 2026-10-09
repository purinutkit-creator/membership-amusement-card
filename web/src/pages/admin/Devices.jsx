import { useState } from 'react';
import { KeyRound, Ban, CheckCircle2, ExternalLink } from 'lucide-react';
import { api } from '../../lib/api.js';
import { dt } from '../../lib/format.js';
import { useSocket } from '../../lib/realtime.js';
import { EntityPage } from '../../components/entity.jsx';
import { Button, Badge, StatusBadge, Modal, useAction, useConfirm, useLoad } from '../../components/ui.jsx';
import { useAuth } from '../../lib/auth.jsx';

const TYPES = ['POS', 'CARD_READER', 'ARCADE_TERMINAL', 'CUSTOMER_DISPLAY', 'PRINTER', 'KIOSK', 'TV_DISPLAY', 'FOOD_TERMINAL'];
const PAGE = { ARCADE_TERMINAL: '/terminal', CARD_READER: '/terminal', FOOD_TERMINAL: '/terminal', KIOSK: '/kiosk', TV_DISPLAY: '/signage', CUSTOMER_DISPLAY: '/display' };

export function DeviceManager({ type, title = 'Devices', subtitle }) {
  const { can } = useAuth();
  const [code, setCode] = useState(null);
  const [tick, setTick] = useState(0);
  const [run] = useAction();
  const confirm = useConfirm();
  const branches = useLoad(() => api.get('/branches'), []);
  useSocket({ 'device:status': () => setTick((t) => t + 1) });
  return (
    <>
      <EntityPage key={tick} title={title} subtitle={subtitle || 'Every device has an ID, branch, location, status, last online, IP and version'} path="/devices" query={type ? { type } : undefined} managePerm="device.manage" singular="device" deletable={false}
        filters={type ? [{ name: 'status', label: 'Status', options: ['ACTIVE', 'BLOCKED', 'INACTIVE'] }] : [{ name: 'type', label: 'Type', options: TYPES }, { name: 'status', label: 'Status', options: ['ACTIVE', 'BLOCKED', 'INACTIVE'] }]}
        extraActions={(r, reload) => can('device.manage') && <>
          {r.status !== 'BLOCKED' && <Button size="sm" icon={KeyRound} onClick={() => run(() => api.post(`/devices/${r.id}/activation-code`)).then(setCode)}>{r.activated ? 'Re-activate' : 'Activate'}</Button>}
          {r.status === 'BLOCKED' ? <Button size="sm" icon={CheckCircle2} onClick={() => run(() => api.post(`/devices/${r.id}/unblock`, {}), { success: 'Unblocked' }).then(reload)}>Unblock</Button>
            : <Button size="sm" variant="ghost" icon={Ban} onClick={async () => { const reason = await confirm({ title: 'Block device', reason: true, danger: true, message: 'The device token is revoked immediately.' }); if (reason) run(() => api.post(`/devices/${r.id}/block`, { reason }), { success: 'Blocked' }).then(reload); }} aria-label="Block" />}
          {PAGE[r.type] && <a className="btn sm ghost" href={PAGE[r.type]} target="_blank" rel="noreferrer" aria-label="Open device page"><ExternalLink size={16} /></a>}
        </>}
        columns={[
          { label: 'Device', render: (r) => <><b>{r.name}</b><div className="xs muted"><code>{r.device_code}</code></div></> }, { key: 'type', label: 'Type', render: (r) => <Badge>{r.type}</Badge> },
          { label: 'Branch / location', render: (r) => <span className="small">{r.branch_name || '—'} · {r.location || '—'}</span> }, { label: 'Machines', render: (r) => <span className="xs">{(r.machines || []).map((m) => m.name).join(', ')}</span> },
          { label: 'Connection', render: (r) => <span className="row gap-s"><span className={`dot ${r.online ? 'on' : 'off'}`} />{r.online ? 'Online' : 'Offline'}</span> }, { label: 'Last online', render: (r) => <span className="xs">{dt(r.last_online_at)}</span> },
          { label: 'IP / version', render: (r) => <span className="xs mono">{r.ip || '—'} {r.version || ''}</span> },
          { label: 'Status', render: (r) => <><StatusBadge status={r.status} /> {!r.activated && <Badge tone="warning">{r.activation_pending ? 'code issued' : 'not activated'}</Badge>}</> },
        ]}
        fields={[{ name: 'deviceCode', label: 'Device ID / code', required: true, upper: true }, { name: 'type', label: 'Type', type: 'select', required: true, options: TYPES.map((v) => ({ value: v, label: v })) }, { name: 'name', label: 'Name', required: true },
          { name: 'branchId', label: 'Branch', type: 'select', options: (branches.data?.items || []).map((b) => ({ value: b.id, label: b.name })) }, { name: 'location', label: 'Location' },
          { name: 'relayUrl', label: 'Machine relay URL (optional — HTTP pulse on Allow Play)', full: true }]}
        defaults={{ type: type || 'ARCADE_TERMINAL' }}
        toForm={(r) => ({ deviceCode: r.device_code, type: r.type, name: r.name, branchId: r.branch_id, location: r.location, relayUrl: r.config?.relayUrl })}
        toPayload={(f) => ({ deviceCode: f.deviceCode, type: f.type, name: f.name, branchId: f.branchId || null, location: f.location || undefined, config: f.relayUrl ? { relayUrl: f.relayUrl } : {} })} />
      <Modal open={!!code} title="Device activation code" onClose={() => setCode(null)}>
        {code && <div className="center col" style={{ alignItems: 'center' }}><div className="muted">Open the device page on the terminal and enter this code:</div><div className="giant mono" style={{ letterSpacing: '.2em' }}>{code.code}</div><div className="small muted">Valid until {dt(code.expiresAt)} · single use. The device receives its own secret token.</div></div>}
      </Modal>
    </>
  );
}

import ReaderPanel from './ReaderPanel.jsx';
export default function Devices() { return <div className="col"><ReaderPanel /><DeviceManager /></div>; }
