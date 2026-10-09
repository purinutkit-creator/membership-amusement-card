import { useState } from 'react';
import { Sparkles, Plus, Trash2, Play, Pause, Check, X } from 'lucide-react';
import { api } from '../../lib/api.js';
import { money, dt, date } from '../../lib/format.js';
import { EntityPage } from '../../components/entity.jsx';
import { Button, Badge, StatusBadge, Tabs, useLoad, useAction, Card, Input, Select, Textarea, Chips, Spinner, Empty, Field } from '../../components/ui.jsx';
import { MediaField, mediaSrc } from '../../components/domain.jsx';
import { useAuth } from '../../lib/auth.jsx';

const EFFECTS = {
  TOP_UP: ['BONUS_AMOUNT', 'BONUS_PERCENT', 'POINT_BONUS', 'STAMP_BONUS'],
  PLAY: ['DISCOUNT_AMOUNT', 'DISCOUNT_PERCENT', 'FIXED_PRICE', 'FREE_PLAY', 'POINT_MULTIPLIER', 'POINT_BONUS', 'STAMP_BONUS', 'STAMP_MULTIPLIER'],
  FOOD: ['DISCOUNT_AMOUNT', 'DISCOUNT_PERCENT', 'POINT_MULTIPLIER', 'POINT_BONUS', 'STAMP_BONUS', 'STAMP_MULTIPLIER'],
  REWARD: ['DISCOUNT_PERCENT'],
};
const RULES = ['MEMBER_ONLY', 'TIER_IN', 'MIN_AMOUNT', 'MIN_PLAYS_TODAY', 'DAYS_OF_WEEK', 'TIME_RANGE', 'BIRTHDAY_MONTH', 'BRANCH_IN', 'MACHINE_IN', 'CATEGORY_IN', 'MERCHANT_IN', 'PACKAGE_IN'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function describe(r) {
  const v = r.value;
  switch (r.type) {
    case 'MEMBER_ONLY': return 'Members only'; case 'BIRTHDAY_MONTH': return 'Birthday month';
    case 'MIN_AMOUNT': return `Min ${money(v)}`; case 'MIN_PLAYS_TODAY': return `≥ ${v} plays today`;
    case 'DAYS_OF_WEEK': return v.map((d) => DAYS[d]).join(','); case 'TIME_RANGE': return `${v.start}–${v.end}`;
    default: return `${r.type.replace('_IN', '')}: ${v.length}`;
  }
}

function RuleBuilder({ value = [], onChange }) {
  const tiers = useLoad(() => api.get('/tiers'), []);
  const branches = useLoad(() => api.get('/branches'), []);
  const machines = useLoad(() => api.get('/machines?pageSize=200').catch(() => ({ items: [] })), []);
  const cats = useLoad(() => api.get('/machine-categories').catch(() => ({ items: [] })), []);
  const merchants = useLoad(() => api.get('/merchants').catch(() => ({ items: [] })), []);
  const packages = useLoad(() => api.get('/packages?all=1'), []);
  const lists = { TIER_IN: tiers, BRANCH_IN: branches, MACHINE_IN: machines, CATEGORY_IN: cats, MERCHANT_IN: merchants, PACKAGE_IN: packages };
  const upd = (i, v) => onChange(value.map((r, j) => (j === i ? { ...r, value: v } : r)));
  return (
    <Field label="Conditions (all must match)">
      <div className="col">
        {value.map((r, i) => (
          <div key={i} className="card tight row wrap">
            <Badge tone="primary">{r.type}</Badge>
            <div className="grow">
              {['MIN_AMOUNT', 'MIN_PLAYS_TODAY'].includes(r.type) && <input className="input" type="number" value={r.value ?? ''} onChange={(e) => upd(i, Number(e.target.value))} />}
              {r.type === 'DAYS_OF_WEEK' && <div className="chips">{DAYS.map((d, k) => <button type="button" key={d} className={`chip ${(r.value || []).includes(k) ? 'active' : ''}`} onClick={() => upd(i, (r.value || []).includes(k) ? r.value.filter((x) => x !== k) : [...(r.value || []), k])}>{d}</button>)}</div>}
              {r.type === 'TIME_RANGE' && <div className="row"><input className="input" type="time" value={r.value?.start || ''} onChange={(e) => upd(i, { ...r.value, start: e.target.value })} />–<input className="input" type="time" value={r.value?.end || ''} onChange={(e) => upd(i, { ...r.value, end: e.target.value })} /></div>}
              {lists[r.type] && <div className="chips">{(lists[r.type].data?.items || []).map((o) => <button type="button" key={o.id} className={`chip ${(r.value || []).includes(o.id) ? 'active' : ''}`} onClick={() => upd(i, (r.value || []).includes(o.id) ? r.value.filter((x) => x !== o.id) : [...(r.value || []), o.id])}>{o.name}</button>)}</div>}
            </div>
            <Button size="sm" variant="ghost" icon={Trash2} onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Remove rule" />
          </div>
        ))}
        <select className="input" value="" onChange={(e) => e.target.value && onChange([...value, { type: e.target.value, value: ['MEMBER_ONLY', 'BIRTHDAY_MONTH'].includes(e.target.value) ? true : e.target.value === 'TIME_RANGE' ? { start: '10:00', end: '15:00' } : ['MIN_AMOUNT', 'MIN_PLAYS_TODAY'].includes(e.target.value) ? 0 : [] }])}>
          <option value="">+ Add condition…</option>{RULES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
    </Field>
  );
}

function PromotionsList() {
  const [run] = useAction();
  return (
    <EntityPage title="Promotions" subtitle="Rule-based: Top-up bonus, play discounts, food deals, birthday, tier, time & day windows" path="/promotions" managePerm="promotion.manage" singular="promotion"
      filters={[{ name: 'status', label: 'Status', options: ['DRAFT', 'ACTIVE', 'INACTIVE'] }, { name: 'appliesTo', label: 'Applies to', options: Object.keys(EFFECTS) }]}
      extraActions={(r, reload) => r.status === 'ACTIVE' ? <Button size="sm" icon={Pause} onClick={() => run(() => api.post(`/promotions/${r.id}/status`, { status: 'INACTIVE' })).then(reload)}>Pause</Button> : <Button size="sm" icon={Play} onClick={() => run(() => api.post(`/promotions/${r.id}/status`, { status: 'ACTIVE' }), { success: 'Activated' }).then(reload)}>Activate</Button>}
      columns={[
        { label: 'Promotion', render: (r) => <><b>{r.name}</b>{r.code && <code className="xs"> {r.code}</code>}<div className="xs muted">{r.description}</div></> },
        { label: 'Applies to', render: (r) => <Badge>{r.applies_to}</Badge> },
        { label: 'Effect', render: (r) => <span className="small">{r.effect_type} {['FREE_PLAY'].includes(r.effect_type) ? '' : r.effect_type.endsWith('PERCENT') ? `${r.effect_value}%` : r.effect_type.endsWith('MULTIPLIER') ? `×${r.effect_value}` : r.effect_type.includes('POINT') || r.effect_type.includes('STAMP') ? `+${r.effect_value}` : money(r.effect_value)}</span> },
        { label: 'Conditions', render: (r) => <div className="chips">{r.rules.map((x, i) => <Badge key={i}>{describe(x)}</Badge>)}</div> },
        { label: 'Priority', num: true, render: (r) => <>{r.priority}{r.stackable && <div className="xs success">stackable</div>}</> },
        { label: 'Period', render: (r) => <span className="xs">{r.start_at ? date(r.start_at) : '∞'} → {r.end_at ? date(r.end_at) : '∞'}</span> },
        { label: 'Used', num: true, render: (r) => <>{r.used_count}{r.usage_limit && `/${r.usage_limit}`}<div className="xs muted">{money(r.total_benefit)}</div></> }, { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
      ]}
      fields={[
        { name: 'name', label: 'Name', required: true }, { name: 'code', label: 'Code' }, { name: 'appliesTo', label: 'Applies to', type: 'select', required: true, options: Object.keys(EFFECTS).map((v) => ({ value: v, label: v })) },
        { name: 'effectType', label: 'Effect', type: 'select', required: true, options: (f) => (EFFECTS[f.appliesTo] || []).map((v) => ({ value: v, label: v })) },
        { name: 'effectValue', label: 'Effect value (฿ / % / × / points)', type: 'number', step: '0.01', min: 0 }, { name: 'maxBenefit', label: 'Max benefit ฿ (optional cap)', type: 'money', min: 0 },
        { name: 'priority', label: 'Priority (lower = higher)', type: 'number', min: 0 }, { name: 'stackable', label: 'Stackable with other promotions', type: 'switch' },
        { name: 'startAt', label: 'Start', type: 'datetime' }, { name: 'endAt', label: 'End', type: 'datetime' }, { name: 'usageLimit', label: 'Total usage limit', type: 'number', min: 1 }, { name: 'perMemberLimit', label: 'Per member limit', type: 'number', min: 1 },
        { name: 'mediaId', label: 'Promotion image', type: 'media', category: 'PROMOTION' }, { name: 'status', label: 'Status', type: 'select', options: ['DRAFT', 'ACTIVE', 'INACTIVE'].map((v) => ({ value: v, label: v })) },
        { name: 'description', label: 'Description', type: 'textarea', full: true },
        { name: 'rules', label: 'Conditions', type: 'custom', full: true, render: ({ value, set }) => <RuleBuilder value={value || []} onChange={set} /> },
      ]}
      defaults={{ appliesTo: 'TOP_UP', effectType: 'BONUS_PERCENT', effectValue: 10, priority: 100, stackable: false, status: 'DRAFT', rules: [] }}
      toForm={(r) => ({ name: r.name, code: r.code, description: r.description, appliesTo: r.applies_to, effectType: r.effect_type, effectValue: r.effect_value, maxBenefit: r.max_benefit, priority: r.priority, stackable: r.stackable, startAt: r.start_at, endAt: r.end_at, usageLimit: r.usage_limit, perMemberLimit: r.per_member_limit, mediaId: r.media_id, status: r.status, rules: r.rules })}
      toPayload={(f) => ({ ...f, effectValue: Number(f.effectValue || 0), maxBenefit: f.maxBenefit === '' || f.maxBenefit == null ? null : Number(f.maxBenefit), priority: Number(f.priority ?? 100), usageLimit: f.usageLimit ? Number(f.usageLimit) : null, perMemberLimit: f.perMemberLimit ? Number(f.perMemberLimit) : null, startAt: f.startAt || null, endAt: f.endAt || null, mediaId: f.mediaId || null, code: f.code || '' })} />
  );
}

export function PackagesList() {
  const tiers = useLoad(() => api.get('/tiers'), []);
  const branches = useLoad(() => api.get('/branches'), []);
  return (
    <EntityPage title="Top-up packages" subtitle="e.g. pay ฿500 receive ฿580" path="/packages" query={{ all: '1' }} paged={false} managePerm="promotion.manage" singular="package"
      columns={[{ key: 'name', label: 'Package', render: (r) => <b>{r.name}</b> }, { label: 'Pay', num: true, render: (r) => money(r.pay_amount) }, { label: 'Bonus', num: true, render: (r) => money(r.bonus_amount) }, { label: 'Receive', num: true, render: (r) => <b>{money(Number(r.pay_amount) + Number(r.bonus_amount))}</b> },
        { label: 'Points / stamps', render: (r) => `+${r.point_bonus} / +${r.stamp_bonus}` }, { label: 'Rules', render: (r) => <span className="xs">{r.member_only && 'Members '}{r.tier_ids?.length > 0 && 'Tier '}{r.branch_ids?.length > 0 && 'Branch '}{r.usage_limit && `limit ${r.used_count}/${r.usage_limit}`}</span> },
        { label: 'Period', render: (r) => <span className="xs">{r.start_at ? date(r.start_at) : '∞'} → {r.end_at ? date(r.end_at) : '∞'}</span> }, { label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]}
      fields={[{ name: 'name', label: 'Name', required: true }, { name: 'payAmount', label: 'Pay amount ฿', type: 'money', required: true, min: 1 }, { name: 'bonusAmount', label: 'Bonus ฿', type: 'money', min: 0 },
        { name: 'pointBonus', label: 'Point bonus', type: 'number', min: 0 }, { name: 'stampBonus', label: 'Stamp bonus', type: 'number', min: 0 }, { name: 'imageMediaId', label: 'Image', type: 'media', category: 'PROMOTION' },
        { name: 'startAt', label: 'Start', type: 'datetime' }, { name: 'endAt', label: 'End', type: 'datetime' }, { name: 'memberOnly', label: 'Members only', type: 'switch' },
        { name: 'tierIds', label: 'Tier restriction', type: 'multiselect', options: (tiers.data?.items || []).map((t) => ({ value: t.id, label: t.name })) },
        { name: 'branchIds', label: 'Branches (none = all)', type: 'multiselect', options: (branches.data?.items || []).map((t) => ({ value: t.id, label: t.name })) },
        { name: 'usageLimit', label: 'Usage limit (total)', type: 'number', min: 1 }, { name: 'perCardLimit', label: 'Limit per card', type: 'number', min: 1 }, { name: 'sort', label: 'Sort', type: 'number' },
        { name: 'status', label: 'Status', type: 'select', options: ['ACTIVE', 'INACTIVE'].map((v) => ({ value: v, label: v })) }]}
      defaults={{ bonusAmount: 0, pointBonus: 0, stampBonus: 0, memberOnly: false, tierIds: [], branchIds: [], sort: 0, status: 'ACTIVE' }}
      toForm={(r) => ({ name: r.name, payAmount: r.pay_amount, bonusAmount: r.bonus_amount, pointBonus: r.point_bonus, stampBonus: r.stamp_bonus, imageMediaId: r.image_media_id, startAt: r.start_at, endAt: r.end_at, memberOnly: r.member_only, tierIds: r.tier_ids, branchIds: r.branch_ids, usageLimit: r.usage_limit, perCardLimit: r.per_card_limit, sort: r.sort, status: r.status })}
      toPayload={(f) => ({ ...f, payAmount: Number(f.payAmount), bonusAmount: Number(f.bonusAmount || 0), pointBonus: Number(f.pointBonus || 0), stampBonus: Number(f.stampBonus || 0), usageLimit: f.usageLimit ? Number(f.usageLimit) : null, perCardLimit: f.perCardLimit ? Number(f.perCardLimit) : null, sort: Number(f.sort || 0), startAt: f.startAt || null, endAt: f.endAt || null, imageMediaId: f.imageMediaId || null })} />
  );
}

function AiGenerator() {
  const { can } = useAuth();
  const promos = useLoad(() => api.get('/promotions?pageSize=100'), []);
  const playlists = useLoad(() => api.get('/playlists'), []);
  const status = useLoad(() => api.get('/ai/status'), []);
  const gens = useLoad(() => api.get('/ai/generations'), []);
  const [f, setF] = useState({ name: '', description: '', discount: '', price: '', period: '', language: 'th', productMediaId: null, promotionId: '' });
  const [preview, setPreview] = useState(null);
  const [playlistId, setPlaylistId] = useState('');
  const [run, busy] = useAction();
  const fromPromo = (id) => { const p = promos.data?.items.find((x) => x.id === id); if (p) setF({ ...f, promotionId: id, name: p.name, description: p.description || '', discount: p.effect_type.endsWith('PERCENT') ? `${Number(p.effect_value)}%` : p.effect_type.includes('BONUS_AMOUNT') ? `+฿${Number(p.effect_value)}` : '', period: [p.start_at && date(p.start_at), p.end_at && date(p.end_at)].filter(Boolean).join(' – ') }); };
  const generate = async () => {
    const r = await run(() => api.post('/ai/generate', { ...f, promotionId: f.promotionId || null, price: f.price ? Number(f.price) : undefined, discount: f.discount || undefined, period: f.period || undefined }), { success: 'Preview generated' });
    setPreview(r); gens.reload(true);
  };
  const review = (g, decision) => run(() => api.post(`/ai/generations/${g.id}/review`, { decision, playlistId: playlistId || null }), { success: decision === 'APPROVED' ? 'Approved — now available for displays' : 'Rejected' }).then(() => { setPreview(null); gens.reload(); });
  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 380px) 1fr' }}>
      <Card title="Generate promotion creative" actions={<Sparkles size={18} color="var(--accent)" />}>
        <div className="col">
          <div className="xs muted">Copywriter: <b>{status.data?.copyProvider}</b>. Creates TV banner (16:9), customer display (9:16), social post (1:1) and an animated motion banner. Nothing is shown publicly until approved.</div>
          <Select label="From promotion (optional)" value={f.promotionId} placeholder="—" options={(promos.data?.items || []).map((p) => ({ value: p.id, label: p.name }))} onChange={(e) => fromPromo(e.target.value)} />
          <Input label="Promotion name *" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Textarea label="Details" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          <div className="grid g2"><Input label="Price ฿" type="number" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /><Input label="Discount / badge" placeholder="e.g. 20% OFF" value={f.discount} onChange={(e) => setF({ ...f, discount: e.target.value })} /></div>
          <Input label="Period" placeholder="1–31 Oct" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} />
          <MediaField label="Product image" value={f.productMediaId} category="PRODUCT" onChange={(id) => setF({ ...f, productMediaId: id })} />
          <Chips options={[{ value: 'th', label: 'ไทย' }, { value: 'en', label: 'EN' }, { value: 'zh', label: '中文' }]} value={f.language} onChange={(l) => setF({ ...f, language: l })} />
          <Button variant="primary" size="lg" icon={Sparkles} loading={busy} disabled={!f.name} onClick={generate}>GENERATE PROMOTION</Button>
        </div>
      </Card>
      <div className="col">
        {preview && <Card title="Preview — awaiting approval" actions={<Badge tone="warning">PENDING APPROVAL</Badge>}>
          {preview.fallbackReason && <div className="alert warning mb">AI copy unavailable ({preview.fallbackReason}); template copy used.</div>}
          <div className="kv mb">{['th', 'en', 'zh'].map((l) => [<div key={`l${l}`}>{l.toUpperCase()}</div>, <div key={`v${l}`}><b>{preview.copy[l].headline}</b> — {preview.copy[l].subtitle} <i>({preview.copy[l].cta})</i></div>]).flat()}</div>
          <div className="auto-grid">{preview.media.map((m) => <a key={m.id} href={m.url} target="_blank" rel="noreferrer" className="card tight"><img src={m.url} alt={m.original_name} style={{ width: '100%', maxHeight: 220, objectFit: 'contain', background: '#111' }} /><div className="xs">{m.meta.format} · {m.meta.width}×{m.meta.height}</div></a>)}</div>
          {can('promotion.approve_media') ? <div className="row mt wrap"><Select value={playlistId} onChange={(e) => setPlaylistId(e.target.value)} placeholder="Don't add to a playlist" options={(playlists.data?.items || []).map((p) => ({ value: p.id, label: `Add to: ${p.name}` }))} />
            <Button variant="success" icon={Check} onClick={() => review(preview.generation, 'APPROVED')}>Approve & publish</Button><Button variant="danger" icon={X} onClick={() => review(preview.generation, 'REJECTED')}>Reject</Button></div>
            : <div className="alert mt">A manager with "Approve promotion media" must approve this before it can be displayed.</div>}
        </Card>}
        <Card title="Generated sets">{gens.loading ? <Spinner /> : !gens.data?.items.length ? <Empty title="Nothing generated yet" /> : gens.data.items.map((g) => (
          <div key={g.id} className="row wrap" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
            <div className="grow"><b>{g.input.name}</b><div className="xs muted">{dt(g.created_at)} · {g.provider} · {g.created_by_name}</div></div>
            <div className="row">{(g.media || []).slice(0, 3).map((m) => <img key={m.id} src={m.url} alt="" style={{ height: 40, borderRadius: 6 }} />)}</div>
            <StatusBadge status={g.status} />
            {g.status === 'PREVIEW' && can('promotion.approve_media') && <><Button size="sm" variant="success" onClick={() => review(g, 'APPROVED')}>Approve</Button><Button size="sm" onClick={() => review(g, 'REJECTED')}>Reject</Button></>}
          </div>))}</Card>
      </div>
    </div>
  );
}

export default function Promotions() {
  const { can } = useAuth();
  const [tab, setTab] = useState('promotions');
  return (
    <div>
      <Tabs tabs={[{ value: 'promotions', label: 'Promotions' }, { value: 'packages', label: 'Top-up packages' }, ...(can('promotion.manage') ? [{ value: 'ai', label: '✨ AI Promotion Generator' }] : [])]} value={tab} onChange={setTab} />
      {tab === 'promotions' && <PromotionsList />}
      {tab === 'packages' && <PackagesList />}
      {tab === 'ai' && <AiGenerator />}
    </div>
  );
}
