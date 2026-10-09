import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Gift, QrCode, CheckCircle2, XCircle, Boxes, Camera } from 'lucide-react';
import { api } from '../../lib/api.js';
import { int, dt } from '../../lib/format.js';
import { Button, Tabs, Card, Input, useAction, Badge, StatusBadge, PagedTable, usePaged, Modal, Select, useConfirm, Empty } from '../../components/ui.jsx';
import { CardScanInput, CardChip, CameraScanner, mediaSrc } from '../../components/domain.jsx';
import { EntityPage } from '../../components/entity.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { useLoad } from '../../components/ui.jsx';
import { useKeyboardWedge } from '../../lib/readers.js';

function Counter() {
  const [code, setCode] = useState('');
  const [found, setFound] = useState(null);
  const [card, setCard] = useState(null);
  const [rewards, setRewards] = useState(null);
  const [cam, setCam] = useState(false);
  const [err, setErr] = useState(null);
  const [run, busy] = useAction();
  const confirm = useConfirm();
  const lookup = async (v) => {
    setErr(null); setFound(null);
    try { setFound(await api.get(`/redemptions/code/${encodeURIComponent(String(v).trim())}`)); } catch (e) { setErr(e.message); }
  };
  useKeyboardWedge((v) => (/^RD\//i.test(v) || /^[A-Z0-9]{8}$/.test(v) ? lookup(v) : null), { enabled: !card });
  const pickCard = async (c) => { setCard(c); const r = await api.get(`/rewards/for-card?identifier=${c.cardNumber}`); setRewards(r.rewards); };
  return (
    <div className="grid g2">
      <Card title="Confirm redemption code" actions={<QrCode size={18} />}>
        <form className="row" onSubmit={(e) => { e.preventDefault(); lookup(code); }}>
          <Input className="grow" size="lg" placeholder="Scan QR or enter 8-char code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoFocus />
          <Button size="lg" icon={Camera} onClick={() => setCam(true)} aria-label="Camera" /><Button size="lg" type="submit">Find</Button></form>
        {err && <div className="alert danger mt-s">{err}</div>}
        {found && (
          <div className="card flat mt col">
            <div className="row between"><b className="big">{found.reward_name}</b><StatusBadge status={found.status} /></div>
            <div className="small">{found.member_name || 'Guest'} · card ••{found.card_number.slice(-4)} · costs {found.points} pts / {found.stamps} stamps · card has {found.card_points} pts / {found.card_stamps} stamps</div>
            <div className="xs muted">Requested {dt(found.created_at)} · expires {dt(found.expires_at)}</div>
            {found.status === 'PENDING' ? <Button variant="success" size="xl" icon={CheckCircle2} loading={busy} onClick={async () => {
              if (!(await confirm({ title: 'Confirm redemption', message: `Hand over "${found.reward_name}" and deduct ${found.points} points / ${found.stamps} stamps?` }))) return;
              await run(() => api.post('/redemptions/confirm', { code: found.code }), { success: 'Redemption confirmed — hand over the reward' }); lookup(found.code);
            }}>CONFIRM REDEMPTION</Button> : <div className="alert warning">This code is {found.status} — it cannot be used again.</div>}
          </div>
        )}
        <CameraScanner open={cam} onClose={() => setCam(false)} onResult={(v) => { setCam(false); setCode(v); lookup(v); }} />
      </Card>
      <Card title="Redeem at counter (scan card)" actions={<Gift size={18} />}>
        {card ? <CardChip card={card} onClear={() => { setCard(null); setRewards(null); }} /> : <CardScanInput wedge={false} autoFocus={false} onCard={pickCard} />}
        {rewards && <div className="auto-grid mt">{rewards.length === 0 ? <Empty title="No rewards" /> : rewards.map((r) => (
          <div key={r.id} className="tile" style={{ cursor: 'default', opacity: r.eligible ? 1 : 0.55 }}>
            {r.image_media_id && <img src={mediaSrc(r.image_media_id)} alt="" style={{ height: 60, objectFit: 'contain' }} />}
            <b>{r.name}</b><span className="xs">{r.points_required > 0 && `${int(r.points_required)} pts`} {r.stamps_required > 0 && `${r.stamps_required} stamps`} · stock {r.stock}</span>
            {!r.eligible && <span className="xs danger">{r.reasons.join(', ')}</span>}
            <Button size="sm" variant="primary" disabled={!r.eligible} loading={busy} onClick={async () => {
              if (!(await confirm({ title: 'Redeem reward', message: `Redeem "${r.name}" for this card?` }))) return;
              const x = await run(() => api.post('/redemptions/counter', { cardId: card.id, rewardId: r.id }), { success: 'Redeemed' });
              setCard(x.card); pickCard(x.card);
            }}>Redeem</Button>
          </div>))}</div>}
      </Card>
    </div>
  );
}

function History() {
  const [status, setStatus] = useState('');
  const st = usePaged('/redemptions', { status });
  const confirm = useConfirm();
  const [run] = useAction();
  const { can } = useAuth();
  return (
    <>
      <div className="toolbar"><select className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{['PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED'].map((s) => <option key={s}>{s}</option>)}</select></div>
      <PagedTable state={st} columns={[{ label: 'Code', render: (r) => <code>{r.code}</code> }, { key: 'reward_name', label: 'Reward' }, { label: 'Member', render: (r) => r.member_name || 'Guest' }, { label: 'Card', render: (r) => <span className="mono xs">{r.card_number}</span> },
        { label: 'Cost', render: (r) => `${r.points} pts / ${r.stamps} st` }, { key: 'channel', label: 'Channel' }, { label: 'Status', render: (r) => <StatusBadge status={r.status} /> }, { label: 'Date', render: (r) => dt(r.created_at) },
        { label: '', render: (r) => can('reward.cancel_redemption') && ['PENDING', 'CONFIRMED'].includes(r.status) && <Button size="sm" icon={XCircle} onClick={async () => { const reason = await confirm({ title: 'Cancel redemption', reason: true, danger: true, message: r.status === 'CONFIRMED' ? 'Points/stamps will be returned via a reversal entry and stock restored.' : '' }); if (reason) run(() => api.post(`/redemptions/${r.id}/cancel`, { reason }), { success: 'Cancelled' }).then(() => st.reload()); }}>Cancel</Button> }]} />
    </>
  );
}

function StockModal({ reward, onClose }) {
  const [type, setType] = useState('IN');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [run, busy] = useAction();
  const moves = useLoad(() => (reward ? api.get(`/stock/movements?kind=REWARD&id=${reward.id}`) : Promise.resolve(null)), [reward?.id]);
  if (!reward) return null;
  return (
    <Modal open title={`Stock — ${reward.name} (now ${reward.stock})`} onClose={() => onClose(false)} size="wide" footer={<Button variant="primary" loading={busy} disabled={qty === ''} onClick={() => run(() => api.post('/stock/move', { kind: 'REWARD', id: reward.id, type, qty: Number(qty), reason }), { success: 'Stock updated' }).then(() => onClose(true))}>Save</Button>}>
      <div className="grid g3"><Select label="Movement" value={type} onChange={(e) => setType(e.target.value)} options={[{ value: 'IN', label: 'Stock in' }, { value: 'OUT', label: 'Stock out' }, { value: 'ADJUST', label: 'Adjust to count' }]} /><Input label="Quantity" type="number" value={qty} onChange={(e) => setQty(e.target.value)} /><Input label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      <h3 className="mt">Movements</h3>
      {(moves.data?.items || []).map((m) => <div key={m.id} className="row between small" style={{ borderBottom: '1px solid var(--border)', padding: '6px 0' }}><Badge>{m.type}</Badge><span className="num">{m.qty > 0 ? `+${m.qty}` : m.qty}</span><span>{m.stock_before} → {m.stock_after}</span><span className="muted">{m.reason || m.reference}</span><span className="faint">{dt(m.created_at)} {m.staff_name}</span></div>)}
    </Modal>
  );
}

export default function Rewards() {
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const [tab, setTab] = useState(sp.get('tab') || (can('reward.redeem') ? 'counter' : 'catalog'));
  const [stock, setStock] = useState(null);
  const tiers = useLoad(() => api.get('/tiers'), []);
  return (
    <div>
      <Tabs tabs={[...(can('reward.redeem') ? [{ value: 'counter', label: 'Redemption counter' }] : []), { value: 'catalog', label: 'Reward catalog' }, { value: 'history', label: 'Redemptions' }]} value={tab} onChange={setTab} />
      {tab === 'counter' && <Counter />}
      {tab === 'history' && <History />}
      {tab === 'catalog' && <EntityPage key={stock ? 'x' : 'y'} title="Rewards" subtitle="Prizes redeemable with points and/or stamps" path="/rewards" managePerm="reward.manage" singular="reward" deleteLabel="Deactivate"
        filters={[{ name: 'status', label: 'Status', options: ['ACTIVE', 'INACTIVE'] }, { name: 'lowStock', label: 'Stock', options: [{ value: '1', label: 'Low stock' }] }]}
        extraActions={(r) => can('stock.manage') && <Button size="sm" icon={Boxes} onClick={() => setStock(r)}>Stock</Button>}
        columns={[{ label: '', render: (r) => r.image_media_id ? <img src={mediaSrc(r.image_media_id)} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 8 }} /> : <Gift /> },
          { key: 'name', label: 'Reward', render: (r) => <><b>{r.name}</b><div className="xs muted">{r.sku} {r.category}</div></> }, { label: 'Points', num: true, render: (r) => int(r.points_required) }, { label: 'Stamps', num: true, render: (r) => int(r.stamps_required) },
          { label: 'Stock', num: true, render: (r) => <span className={r.stock <= r.low_stock_threshold ? 'danger bold' : ''}>{r.stock}</span> }, { label: 'Rules', render: (r) => <span className="xs">{r.member_only && 'Members '}{r.tier_ids?.length > 0 && 'Tier-limited '}{r.limit_per_member && `max ${r.limit_per_member}/member`}</span> }, { label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]}
        fields={(row) => [{ name: 'name', label: 'Name', required: true }, { name: 'sku', label: 'SKU' }, { name: 'barcode', label: 'Barcode' }, { name: 'category', label: 'Category' }, { name: 'imageMediaId', label: 'Image', type: 'media', category: 'REWARD' },
          { name: 'pointsRequired', label: 'Points required', type: 'number', min: 0, required: true }, { name: 'stampsRequired', label: 'Stamps required', type: 'number', min: 0, required: true },
          ...(row?.id ? [] : [{ name: 'stock', label: 'Initial stock', type: 'number', min: 0 }]), { name: 'lowStockThreshold', label: 'Low stock alert at', type: 'number', min: 0 },
          { name: 'memberOnly', label: 'Members only', type: 'switch' }, { name: 'limitPerMember', label: 'Redemption limit per member', type: 'number', min: 1 },
          { name: 'tierIds', label: 'Tier restriction (none = all)', type: 'multiselect', options: (tiers.data?.items || []).map((t) => ({ value: t.id, label: t.name })) },
          { name: 'startAt', label: 'Start', type: 'datetime' }, { name: 'endAt', label: 'End', type: 'datetime' }, { name: 'status', label: 'Status', type: 'select', options: ['ACTIVE', 'INACTIVE'].map((v) => ({ value: v, label: v })) },
          { name: 'description', label: 'Description', type: 'textarea', full: true }]}
        defaults={{ pointsRequired: 0, stampsRequired: 0, stock: 0, lowStockThreshold: 0, memberOnly: true, status: 'ACTIVE', category: 'GENERAL', tierIds: [] }}
        toForm={(r) => ({ name: r.name, sku: r.sku, barcode: r.barcode, category: r.category, imageMediaId: r.image_media_id, pointsRequired: r.points_required, stampsRequired: r.stamps_required, lowStockThreshold: r.low_stock_threshold, memberOnly: r.member_only, limitPerMember: r.limit_per_member, tierIds: r.tier_ids, startAt: r.start_at, endAt: r.end_at, status: r.status, description: r.description })}
        toPayload={(f) => ({ ...f, pointsRequired: Number(f.pointsRequired || 0), stampsRequired: Number(f.stampsRequired || 0), stock: f.stock === undefined ? undefined : Number(f.stock || 0), lowStockThreshold: Number(f.lowStockThreshold || 0), limitPerMember: f.limitPerMember ? Number(f.limitPerMember) : null, startAt: f.startAt || null, endAt: f.endAt || null, imageMediaId: f.imageMediaId || null, branchIds: [] })} />}
      <StockModal reward={stock} onClose={() => setStock(null)} />
    </div>
  );
}
