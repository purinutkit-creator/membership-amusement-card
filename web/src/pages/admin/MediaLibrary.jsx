import { useRef, useState } from 'react';
import { Upload, Trash2, Check, X, Image as ImageIcon, Film, Type, Music } from 'lucide-react';
import { api } from '../../lib/api.js';
import { dt } from '../../lib/format.js';
import { Button, PageHeader, Chips, usePaged, Async, Empty, Badge, Pager, useAction, useConfirm, Select } from '../../components/ui.jsx';
import { useAuth } from '../../lib/auth.jsx';

const CATS = ['GENERAL', 'LOGO', 'PRODUCT', 'TIER_ICON', 'PROMOTION', 'REWARD', 'BACKGROUND', 'FONT', 'SOUND'];
export default function MediaLibrary() {
  const { can } = useAuth();
  const [kind, setKind] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [upCat, setUpCat] = useState('GENERAL');
  const [drag, setDrag] = useState(false);
  const st = usePaged('/media', { kind, category, status });
  const [run, busy] = useAction();
  const confirm = useConfirm();
  const ref = useRef(null);
  const upload = (files) => {
    if (!files?.length) return;
    const fd = new FormData(); fd.append('category', upCat); for (const f of files) fd.append('files', f);
    run(() => api.upload('/media', fd), { success: `${files.length} file(s) uploaded` }).then(() => st.reload());
  };
  const icon = (m) => (m.kind === 'IMAGE' ? <img src={m.url} alt="" style={{ width: '100%', height: 120, objectFit: 'contain', background: 'repeating-conic-gradient(#eee 0 25%, #fff 0 50%) 50% / 16px 16px', borderRadius: 8 }} /> : m.kind === 'VIDEO' ? <video src={m.url} style={{ width: '100%', height: 120 }} muted /> : m.kind === 'FONT' ? <Type size={48} /> : m.kind === 'SOUND' ? <Music size={48} /> : <ImageIcon size={48} />);
  return (
    <div>
      <PageHeader title="Media Library" subtitle="Logos, products, tier icons, promotions, rewards, backgrounds, videos, fonts and sounds" />
      <div className={`card center col ${drag ? 'selected' : ''}`} style={{ borderStyle: 'dashed', alignItems: 'center', borderColor: drag ? 'var(--primary)' : undefined }} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files); }}>
        <Upload size={32} /><div>Drag & drop images, videos (mp4/webm), fonts (ttf/otf/woff/woff2) or sounds here</div>
        <div className="row"><Select value={upCat} onChange={(e) => setUpCat(e.target.value)} options={CATS} /><Button variant="primary" icon={Upload} loading={busy} onClick={() => ref.current.click()}>Choose files</Button></div>
        <input ref={ref} type="file" hidden multiple accept="image/*,video/mp4,video/webm,.ttf,.otf,.woff,.woff2,audio/*" onChange={(e) => upload(e.target.files)} />
        {upCat === 'PROMOTION' && !can('promotion.approve_media') && <div className="xs warning">Promotion uploads need manager approval before they appear on displays.</div>}
      </div>
      <div className="toolbar mt"><Chips options={[{ value: '', label: 'All' }, { value: 'IMAGE', label: 'Images' }, { value: 'VIDEO', label: 'Videos' }, { value: 'FONT', label: 'Fonts' }, { value: 'SOUND', label: 'Sounds' }]} value={kind} onChange={setKind} />
        <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All categories</option>{CATS.map((c) => <option key={c}>{c}</option>)}</select>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option>{['APPROVED', 'PENDING_APPROVAL', 'REJECTED'].map((c) => <option key={c}>{c}</option>)}</select></div>
      <Async state={st} isEmpty={(d) => !d.items.length} empty={<Empty title="No media yet" />}>{(d) => <>
        <div className="auto-grid">{d.items.map((m) => (
          <div key={m.id} className="card tight col gap-s">
            <a href={m.url} target="_blank" rel="noreferrer" style={{ display: 'grid', placeItems: 'center', minHeight: 120, color: 'var(--text-3)' }}>{icon(m)}</a>
            <div className="small bold" style={{ wordBreak: 'break-all' }}>{m.original_name}</div>
            <div className="row wrap gap-s"><Badge>{m.category}</Badge>{m.generated && <Badge tone="primary">AI</Badge>}{m.status !== 'APPROVED' && <Badge tone={m.status === 'REJECTED' ? 'danger' : 'warning'}>{m.status}</Badge>}</div>
            <div className="xs faint">{(m.size / 1024).toFixed(0)} KB · {dt(m.created_at)}</div>
            <div className="row">
              {m.status === 'PENDING_APPROVAL' && can('promotion.approve_media') && <><Button size="sm" variant="success" icon={Check} onClick={() => run(() => api.post(`/media/${m.id}/review`, { status: 'APPROVED' }), { success: 'Approved' }).then(() => st.reload(true))}>Approve</Button><Button size="sm" icon={X} onClick={() => run(() => api.post(`/media/${m.id}/review`, { status: 'REJECTED' })).then(() => st.reload(true))} aria-label="Reject" /></>}
              {can('media.manage') && <Button size="sm" variant="ghost" icon={Trash2} onClick={async () => { if (await confirm({ title: 'Delete file', message: m.original_name, danger: true })) run(() => api.del(`/media/${m.id}`), { success: 'Deleted' }).then(() => st.reload(true)); }} aria-label="Delete" />}
              <Button size="sm" variant="ghost" onClick={() => navigator.clipboard?.writeText(m.id)}>Copy ID</Button>
            </div>
          </div>))}</div>
        <Pager page={d.page} pages={d.pages} total={d.total} onPage={st.setPage} /></>}
      </Async>
      <span hidden><Film /></span>
    </div>
  );
}
