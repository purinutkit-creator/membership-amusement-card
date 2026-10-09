import { useState } from 'react';
import { Gamepad2, Wrench, Power } from 'lucide-react';
import { api } from '../../lib/api.js';
import { money, int, dt } from '../../lib/format.js';
import { useSocket } from '../../lib/realtime.js';
import { EntityPage } from '../../components/entity.jsx';
import { Button, Badge, StatusBadge, useLoad, useAction, Tabs } from '../../components/ui.jsx';
import { mediaSrc } from '../../components/domain.jsx';
import { useAuth } from '../../lib/auth.jsx';

export default function Machines() {
  const { can } = useAuth();
  const [tab, setTab] = useState('machines');
  const [tick, setTick] = useState(0);
  const cats = useLoad(() => api.get('/machine-categories'), [tab]);
  const tiers = useLoad(() => api.get('/tiers'), []);
  const devices = useLoad(() => api.get('/devices?type=ARCADE_TERMINAL&pageSize=200').catch(() => ({ items: [] })), []);
  const branches = useLoad(() => api.get('/branches'), []);
  const [run] = useAction();
  useSocket({ 'machine:update': () => setTick((t) => t + 1), 'device:status': () => setTick((t) => t + 1), 'txn:new': (e) => e.type === 'PLAY' && setTick((t) => t + 1) });
  const opts = (st, l = 'name') => (st.data?.items || []).map((x) => ({ value: x.id, label: x[l] }));
  return (
    <div>
      <Tabs tabs={[{ value: 'machines', label: 'Machines / Attractions' }, { value: 'categories', label: 'Categories' }]} value={tab} onChange={setTab} />
      {tab === 'categories' ? <EntityPage title="Machine categories" path="/machine-categories" paged={false} managePerm="machine.manage" singular="category"
        columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'sort', label: 'Sort', num: true }]}
        fields={[{ name: 'code', label: 'Code', required: true, upper: true }, { name: 'name', label: 'Name', required: true }, { name: 'icon', label: 'Icon name' }, { name: 'sort', label: 'Sort', type: 'number' }]} defaults={{ sort: 0 }} /> : (
        <EntityPage key={tick} title="Machines / Attractions" subtitle="Status updates in real time from terminals" path="/machines" managePerm="machine.manage" singular="machine" deleteLabel="Delete / disable"
          filters={[{ name: 'status', label: 'Status', options: ['AVAILABLE', 'MAINTENANCE', 'DISABLED', 'ERROR'] }, { name: 'online', label: 'Connection', options: [{ value: '1', label: 'Online' }, { value: '0', label: 'Offline' }] }, { name: 'categoryId', label: 'Category', options: opts(cats) }]}
          extraActions={(r, reload) => <>
            {r.status === 'AVAILABLE' ? <Button size="sm" icon={Wrench} onClick={() => run(() => api.post(`/machines/${r.id}/status`, { status: 'MAINTENANCE' }), { success: 'Maintenance' }).then(reload)}>Maint.</Button>
              : <Button size="sm" icon={Power} onClick={() => run(() => api.post(`/machines/${r.id}/status`, { status: 'AVAILABLE' }), { success: 'Available' }).then(reload)}>Enable</Button>}
            <a className="btn sm" href={`/terminal?machine=${r.id}`} target="_blank" rel="noreferrer">Terminal</a></>}
          columns={[
            { label: '', render: (r) => r.image_media_id ? <img src={mediaSrc(r.image_media_id)} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 8 }} /> : <Gamepad2 /> },
            { label: 'Machine', render: (r) => <><b>{r.name}</b><div className="xs muted"><code>{r.machine_code}</code> · {r.category_name || '—'} · Zone {r.zone || '—'}</div></> },
            { label: 'Price', num: true, render: (r) => <>{r.free_play ? <Badge tone="success">FREE</Badge> : money(r.price)}{r.member_price != null && <div className="xs muted">member {money(r.member_price)}</div>}{r.happy_hour?.enabled && <div className="xs muted">HH {money(r.happy_hour.price)}</div>}</> },
            { label: 'Earn', render: (r) => <span className="xs">{r.point_earn} pts · {r.stamp_earn} stamps</span> },
            { label: 'Today', num: true, render: (r) => can('dashboard.revenue') ? <>{int(r.plays_today)} plays<div className="xs muted">{money(r.revenue_today)}</div></> : int(r.plays_today) },
            { label: 'Terminal', render: (r) => r.device_code ? <span className="row gap-s"><span className={`dot ${r.online ? 'on' : 'off'}`} /> <span className="xs">{r.device_code}</span></span> : <span className="faint xs">not linked</span> },
            { label: 'Status', render: (r) => <><StatusBadge status={r.status} /> <Badge tone={r.online ? 'success' : ''}>{r.online ? 'ONLINE' : 'OFFLINE'}</Badge><div className="xs faint">{r.last_seen_at && dt(r.last_seen_at)}</div></> },
          ]}
          fields={[
            { name: 'machineCode', label: 'Machine code', required: true, upper: true }, { name: 'name', label: 'Name', required: true }, { name: 'categoryId', label: 'Category', type: 'select', options: opts(cats) },
            { name: 'branchId', label: 'Branch', type: 'select', options: opts(branches) }, { name: 'zone', label: 'Zone' }, { name: 'location', label: 'Location' }, { name: 'imageMediaId', label: 'Image', type: 'media', category: 'PRODUCT' },
            { name: 'deviceId', label: 'Reader / terminal device', type: 'select', options: (devices.data?.items || []).map((d) => ({ value: d.id, label: `${d.name} (${d.device_code})` })) },
            { name: 'price', label: 'Price per play ฿', type: 'money', required: true, min: 0 }, { name: 'memberPrice', label: 'Member price ฿', type: 'money', min: 0 },
            ...(tiers.data?.items || []).map((t) => ({ name: `tier_${t.id}`, label: `${t.name} tier price ฿`, type: 'money', min: 0 })),
            { name: 'hhEnabled', label: 'Happy hour', type: 'switch' }, { name: 'hhPrice', label: 'Happy hour price ฿', type: 'money', min: 0, show: (f) => f.hhEnabled }, { name: 'hhDays', label: 'Happy hour days', type: 'days', show: (f) => f.hhEnabled },
            { name: 'hhStart', label: 'From', type: 'time', show: (f) => f.hhEnabled }, { name: 'hhEnd', label: 'To', type: 'time', show: (f) => f.hhEnabled },
            { name: 'freePlay', label: 'Free play', type: 'switch' }, { name: 'pointEarn', label: 'Points per play', type: 'number', min: 0 }, { name: 'stampEarn', label: 'Stamps per play', type: 'number', min: 0 },
            { name: 'creditsPerPlay', label: 'Credits pulsed per play', type: 'number', min: 1 }, { name: 'cooldownSec', label: 'Duplicate-tap cooldown (sec, blank = default)', type: 'number', min: 0 },
            { name: 'status', label: 'Status', type: 'select', options: ['AVAILABLE', 'MAINTENANCE', 'DISABLED', 'ERROR'].map((v) => ({ value: v, label: v })) }, { name: 'note', label: 'Note', type: 'textarea', full: true },
          ]}
          defaults={{ price: 40, pointEarn: 0, stampEarn: 1, creditsPerPlay: 1, status: 'AVAILABLE', hhDays: [] }}
          toForm={(r) => ({ machineCode: r.machine_code, name: r.name, categoryId: r.category_id, branchId: r.branch_id, zone: r.zone, location: r.location, imageMediaId: r.image_media_id, deviceId: r.device_id, price: r.price, memberPrice: r.member_price,
            ...Object.fromEntries(Object.entries(r.tier_prices || {}).map(([k, v]) => [`tier_${k}`, v])), hhEnabled: r.happy_hour?.enabled, hhPrice: r.happy_hour?.price, hhDays: r.happy_hour?.days || [], hhStart: r.happy_hour?.start, hhEnd: r.happy_hour?.end,
            freePlay: r.free_play, pointEarn: r.point_earn, stampEarn: r.stamp_earn, creditsPerPlay: r.credits_per_play, cooldownSec: r.cooldown_sec, status: r.status, note: r.note })}
          toPayload={(f) => ({
            machineCode: f.machineCode, name: f.name, categoryId: f.categoryId || null, branchId: f.branchId || null, zone: f.zone || undefined, location: f.location || undefined, imageMediaId: f.imageMediaId || null, deviceId: f.deviceId || null,
            price: Number(f.price), memberPrice: f.memberPrice === '' || f.memberPrice == null ? null : Number(f.memberPrice),
            tierPrices: Object.fromEntries(Object.entries(f).filter(([k, v]) => k.startsWith('tier_') && v !== '' && v != null).map(([k, v]) => [k.slice(5), Number(v)])),
            happyHour: { enabled: !!f.hhEnabled, price: f.hhPrice === '' || f.hhPrice == null ? undefined : Number(f.hhPrice), days: f.hhDays || [], start: f.hhStart || undefined, end: f.hhEnd || undefined },
            freePlay: !!f.freePlay, pointEarn: Number(f.pointEarn || 0), stampEarn: Number(f.stampEarn || 0), creditsPerPlay: Number(f.creditsPerPlay || 1), cooldownSec: f.cooldownSec === '' || f.cooldownSec == null ? null : Number(f.cooldownSec), status: f.status || 'AVAILABLE', note: f.note || undefined,
          })} />
      )}
    </div>
  );
}
