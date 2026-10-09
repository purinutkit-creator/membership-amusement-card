import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, UserPlus, Download, Merge } from 'lucide-react';
import { api, download } from '../../lib/api.js';
import { money, int, date } from '../../lib/format.js';
import { Button, PageHeader, PagedTable, usePaged, useDebounced, StatusBadge, Badge, useLoad, Modal, Input, useAction, Textarea } from '../../components/ui.jsx';
import { RegisterMemberModal } from './pos/parts.jsx';
import { useAuth } from '../../lib/auth.jsx';

export default function Members() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [tierId, setTierId] = useState('');
  const [sort, setSort] = useState('');
  const [reg, setReg] = useState(false);
  const [merge, setMerge] = useState(false);
  const dq = useDebounced(q);
  const tiers = useLoad(() => api.get('/tiers'), []);
  const st = usePaged('/members', { q: dq, status, tierId, sort });
  return (
    <div>
      <PageHeader title="Members" subtitle="Search by name, phone, member ID or card number" actions={<>
        {can('report.export') && <Button icon={Download} onClick={() => download('/reports/member?format=xlsx', 'members.xlsx')}>Export</Button>}
        {can('member.merge') && <Button icon={Merge} onClick={() => setMerge(true)}>Merge duplicates</Button>}
        {can('member.create') && <Button variant="primary" icon={UserPlus} onClick={() => setReg(true)}>Register member</Button>}</>} />
      <div className="toolbar">
        <div className="search-box"><Search size={18} /><input className="input" placeholder="Name, phone, MBR…, card number" value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></div>
        <select className="input" value={tierId} onChange={(e) => setTierId(e.target.value)}><option value="">All tiers</option>{tiers.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['ACTIVE', 'SUSPENDED', 'BLOCKED'].map((s) => <option key={s}>{s}</option>)}</select>
        <select className="input" value={sort} onChange={(e) => setSort(e.target.value)}><option value="">Newest</option><option value="name">Name</option><option value="spend">Top spend</option><option value="points">Top points</option></select>
      </div>
      <PagedTable state={st} onRowClick={(r) => nav(`/members/${r.id}`)} columns={[
        { key: 'member_code', label: 'Member ID', render: (r) => <code>{r.member_code}</code> },
        { label: 'Name', render: (r) => <><b>{r.first_name} {r.last_name}</b>{r.nickname && <span className="muted"> ({r.nickname})</span>}</> },
        { key: 'phone', label: 'Phone' },
        { label: 'Tier', render: (r) => r.tier_name && <Badge><span className="dot" style={{ background: r.tier_color }} /> {r.tier_name}</Badge> },
        { label: 'Balance', num: true, render: (r) => money(r.balance) }, { label: 'Points', num: true, render: (r) => int(r.points) }, { label: 'Stamps', num: true, render: (r) => int(r.stamps) },
        { label: 'Total spend', num: true, render: (r) => money(r.total_spend) }, { key: 'card_count', label: 'Cards', num: true },
        { label: 'Joined', render: (r) => date(r.join_date) }, { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
      ]} />
      <RegisterMemberModal open={reg} onClose={(m) => { setReg(false); if (m) nav(`/members/${m.id}`); }} />
      <MergeModal open={merge} onClose={() => setMerge(false)} onDone={(id) => nav(`/members/${id}`)} />
    </div>
  );
}

function MergeModal({ open, onClose, onDone }) {
  const [src, setSrc] = useState('');
  const [dst, setDst] = useState('');
  const [reason, setReason] = useState('');
  const [found, setFound] = useState({});
  const [run, busy] = useAction();
  const look = async (k, v) => { try { const m = await api.get(`/members/lookup?${/^MBR/i.test(v) ? 'code' : 'phone'}=${encodeURIComponent(v)}`); setFound((f) => ({ ...f, [k]: m })); } catch (e) { setFound((f) => ({ ...f, [k]: { error: e.message } })); } };
  const show = (m) => (m ? (m.error ? <span className="danger">{m.error}</span> : <span className="small">{m.memberCode} · {m.firstName} {m.lastName} · {m.cards.length} card(s) · {m.lifetimePoints} lifetime pts</span>) : null);
  return (
    <Modal open={open} title="Merge duplicate members" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button>
      <Button variant="danger" loading={busy} disabled={!found.src?.id || !found.dst?.id || reason.length < 3} onClick={() => run(() => api.post('/members/merge', { sourceId: found.src.id, targetId: found.dst.id, reason }), { success: (r) => `Merged — ${r.movedCards} card(s) moved` }).then(() => { onClose(); onDone(found.dst.id); })}>Merge</Button></>}>
      <div className="col">
        <div className="alert warning">Cards (with balance, points & stamps), history, redemptions and consents move from the duplicate into the kept member. The duplicate becomes MERGED. This is audited.</div>
        <div className="row"><Input className="grow" label="Duplicate (will be merged)" placeholder="Phone or MBR ID" value={src} onChange={(e) => setSrc(e.target.value)} onBlur={() => src && look('src', src)} /></div>{show(found.src)}
        <div className="row"><Input className="grow" label="Keep this member" placeholder="Phone or MBR ID" value={dst} onChange={(e) => setDst(e.target.value)} onBlur={() => dst && look('dst', dst)} /></div>{show(found.dst)}
        <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Modal>
  );
}
