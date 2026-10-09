import { useState } from 'react';
import { Plus, Trash2, Pencil, ExternalLink, Image as ImageIcon, Type, Film, ArrowUp, ArrowDown } from 'lucide-react';
import { api } from '../../lib/api.js';
import { EntityPage, EntityForm } from '../../components/entity.jsx';
import { Button, Badge, StatusBadge, useLoad, Card, Empty, useAction, Modal } from '../../components/ui.jsx';
import { MediaPicker } from '../../components/domain.jsx';

function PlaylistItems({ playlist, onClose }) {
  const st = useLoad(() => api.get(`/playlists/${playlist.id}`), [playlist.id]);
  const [edit, setEdit] = useState(null);
  const [pick, setPick] = useState(null);
  const [run] = useAction();
  const items = st.data?.items || [];
  const save = (f, id) => {
    const body = { itemType: f.itemType, mediaId: f.mediaId || null, durationSec: f.durationSec ? Number(f.durationSec) : null, sort: Number(f.sort || 0), priority: Number(f.priority || 0), enabled: f.enabled !== false,
      startDate: f.startDate || null, endDate: f.endDate || null, daysOfWeek: f.daysOfWeek || [], startTime: f.startTime || null, endTime: f.endTime || null,
      textContent: f.itemType === 'TEXT' ? { title: { th: f.t_th, en: f.t_en, zh: f.t_zh }, subtitle: { th: f.s_th, en: f.s_en, zh: f.s_zh }, background: f.background, color: f.color } : null };
    return id ? api.put(`/playlists/${playlist.id}/items/${id}`, body) : api.post(`/playlists/${playlist.id}/items`, body);
  };
  const move = (it, d) => run(() => save({ ...toForm(it), sort: (it.sort || 0) + d }, it.id)).then(() => st.reload(true));
  return (
    <Modal open title={`Playlist — ${playlist.name}`} size="xwide" onClose={onClose} footer={<a className="btn" href={`/signage?playlist=${playlist.id}`} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Preview full screen</a>}>
      <div className="row mb"><Button icon={ImageIcon} onClick={() => setPick('IMAGE')}>Add image</Button><Button icon={Film} onClick={() => setPick('VIDEO')}>Add video</Button><Button icon={Type} onClick={() => setEdit({ itemType: 'TEXT', durationSec: 8, background: '#6D28D9', color: '#ffffff', enabled: true })}>Add text slide</Button></div>
      {items.length === 0 ? <Empty title="Empty playlist" /> : (
        <div className="col">{items.map((it) => (
          <div key={it.id} className="card tight row wrap">
            <div style={{ width: 120, height: 68, background: it.text_content?.background || '#000', borderRadius: 8, display: 'grid', placeItems: 'center', overflow: 'hidden', color: it.text_content?.color || '#fff', fontSize: 11 }}>
              {it.kind === 'IMAGE' ? <img src={it.url} alt="" style={{ maxWidth: '100%', maxHeight: '100%' }} /> : it.kind === 'VIDEO' ? <Film /> : it.text_content?.title?.th || it.text_content?.title?.en}</div>
            <div className="grow"><b>{it.item_type === 'TEXT' ? it.text_content?.title?.en || it.text_content?.title?.th : it.original_name}</b>
              <div className="xs muted">{it.item_type} · {it.duration_sec ? `${it.duration_sec}s` : it.item_type === 'VIDEO' ? 'full video' : '10s'} · priority {it.priority}{it.start_date && ` · ${it.start_date}→${it.end_date || '∞'}`}{it.days_of_week?.length > 0 && ` · days ${it.days_of_week.join(',')}`}{it.start_time && ` · ${it.start_time.slice(0, 5)}-${it.end_time?.slice(0, 5)}`}</div>
              {it.media_status && it.media_status !== 'APPROVED' && <Badge tone="warning">media {it.media_status} — hidden until approved</Badge>}{!it.enabled && <Badge>disabled</Badge>}</div>
            <Button size="sm" icon={ArrowUp} onClick={() => move(it, -1)} aria-label="Up" /><Button size="sm" icon={ArrowDown} onClick={() => move(it, 1)} aria-label="Down" />
            <Button size="sm" icon={Pencil} onClick={() => setEdit({ ...toForm(it), id: it.id })} aria-label="Edit" />
            <Button size="sm" variant="ghost" icon={Trash2} onClick={() => run(() => api.del(`/playlists/${playlist.id}/items/${it.id}`)).then(() => st.reload(true))} aria-label="Delete" />
          </div>))}</div>
      )}
      <MediaPicker open={!!pick} kind={pick} category="PROMOTION" onClose={() => setPick(null)} onPick={(m) => { setPick(null); setEdit({ itemType: pick, mediaId: m.id, durationSec: pick === 'VIDEO' ? '' : 10, enabled: true, sort: items.length }); }} />
      <EntityForm open={!!edit} title="Playlist item" initial={edit} onClose={(s) => { setEdit(null); if (s) st.reload(true); }} onSubmit={(f) => save(f, edit?.id)}
        fields={[
          { name: 'durationSec', label: 'Duration (sec) — blank = full video / 10s', type: 'number', min: 1 }, { name: 'priority', label: 'Priority (higher first)', type: 'number' }, { name: 'sort', label: 'Sort', type: 'number' }, { name: 'enabled', label: 'Enabled', type: 'switch' },
          { name: 'startDate', label: 'Start date', type: 'date' }, { name: 'endDate', label: 'End date', type: 'date' }, { name: 'daysOfWeek', label: 'Days of week (none = every day)', type: 'days' }, { name: 'startTime', label: 'Start time', type: 'time' }, { name: 'endTime', label: 'End time', type: 'time' },
          ...(edit?.itemType === 'TEXT' ? [{ name: 't_th', label: 'Title (ไทย)' }, { name: 's_th', label: 'Subtitle (ไทย)' }, { name: 't_en', label: 'Title (EN)' }, { name: 's_en', label: 'Subtitle (EN)' }, { name: 't_zh', label: 'Title (中文)' }, { name: 's_zh', label: 'Subtitle (中文)' }, { name: 'background', label: 'Background', type: 'color' }, { name: 'color', label: 'Text color', type: 'color' }] : []),
        ]} />
    </Modal>
  );
}
const toForm = (it) => ({ itemType: it.item_type, mediaId: it.media_id, durationSec: it.duration_sec, sort: it.sort, priority: it.priority, enabled: it.enabled, startDate: it.start_date, endDate: it.end_date, daysOfWeek: it.days_of_week, startTime: it.start_time?.slice(0, 5), endTime: it.end_time?.slice(0, 5),
  t_th: it.text_content?.title?.th, t_en: it.text_content?.title?.en, t_zh: it.text_content?.title?.zh, s_th: it.text_content?.subtitle?.th, s_en: it.text_content?.subtitle?.en, s_zh: it.text_content?.subtitle?.zh, background: it.text_content?.background, color: it.text_content?.color });

export default function PromotionDisplays() {
  const [open, setOpen] = useState(null);
  const branches = useLoad(() => api.get('/branches'), []);
  return (
    <div className="col">
      <EntityPage title="Promotion Displays" subtitle="Playlists for TV / monitors / digital signage and the customer display idle screen" path="/playlists" paged={false} managePerm="display.manage" singular="playlist"
        onRowClick={setOpen} extraActions={(r) => <><Button size="sm" onClick={() => setOpen(r)}>Items</Button><a className="btn sm" href={`/signage?playlist=${r.id}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Play</a></>}
        columns={[{ key: 'name', label: 'Playlist', render: (r) => <b>{r.name}</b> }, { key: 'target', label: 'Target', render: (r) => <Badge>{r.target}</Badge> }, { key: 'item_count', label: 'Items', num: true }, { label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]}
        fields={[{ name: 'name', label: 'Name', required: true }, { name: 'target', label: 'Target', type: 'select', options: ['ALL', 'TV', 'CUSTOMER_DISPLAY', 'TERMINAL'].map((v) => ({ value: v, label: v })) },
          { name: 'branchId', label: 'Branch', type: 'select', options: (branches.data?.items || []).map((b) => ({ value: b.id, label: b.name })) }, { name: 'status', label: 'Status', type: 'select', options: ['ACTIVE', 'INACTIVE'].map((v) => ({ value: v, label: v })) }]}
        defaults={{ target: 'ALL', status: 'ACTIVE' }} toForm={(r) => ({ name: r.name, target: r.target, branchId: r.branch_id, status: r.status })} toPayload={(f) => ({ ...f, branchId: f.branchId || null })} />
      <Card><div className="small">Open <code>{location.origin}/signage</code> on any TV / monitor (full screen), choose a playlist. Approved media only; schedules (dates, days, times, priority) are applied live, and edits push to screens in real time.</div></Card>
      {open && <PlaylistItems playlist={open} onClose={() => setOpen(null)} />}
      <span hidden><Plus /></span>
    </div>
  );
}
