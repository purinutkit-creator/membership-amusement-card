import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Pencil, KeyRound, Ban, CheckCircle2, Trash2, CreditCard, ShoppingCart } from 'lucide-react';
import { api } from '../../lib/api.js';
import { money, int, date, dt, signed, TXN_LABEL } from '../../lib/format.js';
import { useSocket } from '../../lib/realtime.js';
import { Button, Card, PageHeader, useLoad, Async, StatusBadge, Badge, Table, Tabs, Kv, Pager, usePaged, Chips, useAction, useConfirm, Modal, Input } from '../../components/ui.jsx';
import { EntityForm } from '../../components/entity.jsx';
import { useAuth } from '../../lib/auth.jsx';

export const TIMELINE_FILTERS = [{ value: '', label: 'All' }, { value: 'topup', label: 'Top Up' }, { value: 'play', label: 'Play' }, { value: 'food', label: 'Food' }, { value: 'point', label: 'Point' }, { value: 'stamp', label: 'Stamp' }, { value: 'reward', label: 'Reward' }, { value: 'refund', label: 'Refund' }, { value: 'adjustment', label: 'Adjustment' }];

export function Timeline({ path }) {
  const [type, setType] = useState('');
  const st = usePaged(path, { type });
  const nav = useNavigate();
  useSocket({ 'card:update': () => st.reload(true) });
  return (
    <div className="col">
      <Chips options={TIMELINE_FILTERS} value={type} onChange={setType} />
      <Async state={st} isEmpty={(d) => !d.items.length}>{(d) => <>
        <Table onRowClick={(r) => nav(`/transactions/${r.id}`)} columns={[
          { label: 'Date', render: (r) => dt(r.created_at) }, { label: 'Type', render: (r) => <Badge tone={r.reversed_by ? 'warning' : r.amount < 0 ? 'info' : 'success'}>{TXN_LABEL[r.type] || r.type}{r.reversed_by ? ' (reversed)' : ''}</Badge> },
          { key: 'txn_no', label: 'Txn', render: (r) => <code className="xs">{r.txn_no}</code> }, { label: 'Card', render: (r) => <span className="mono xs">{r.card_number}</span> },
          { label: 'Amount', num: true, render: (r) => (Number(r.amount) || Number(r.bonus) ? <span className={r.amount < 0 ? 'danger' : 'success'}>{signed(Number(r.amount), money)}{Number(r.bonus) > 0 && ` +${money(r.bonus)}`}</span> : '') },
          { label: 'Balance', num: true, render: (r) => money(r.balance_after) }, { label: 'Pts', num: true, render: (r) => (r.points_delta ? signed(r.points_delta) : '') }, { label: 'Stamps', num: true, render: (r) => (r.stamps_delta ? signed(r.stamps_delta) : '') },
          { label: 'Where', render: (r) => <span className="xs muted">{r.machine_name || r.order_no || r.reason || ''} {r.staff_name && `· ${r.staff_name}`}</span> },
        ]} rows={d.items} /><Pager page={d.page} pages={d.pages} total={d.total} onPage={st.setPage} /></>}
      </Async>
    </div>
  );
}

export default function MemberDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [run] = useAction();
  const [tab, setTab] = useState('activity');
  const [edit, setEdit] = useState(false);
  const [pin, setPin] = useState(null);
  const st = useLoad(() => api.get(`/members/${id}`), [id]);
  const tiers = useLoad(() => api.get('/tiers'), []);
  const reds = useLoad(() => (tab === 'rewards' ? api.get(`/members/${id}/redemptions`) : Promise.resolve(null)), [id, tab]);
  const cons = useLoad(() => (tab === 'privacy' ? api.get(`/members/${id}/consents`) : Promise.resolve(null)), [id, tab]);
  useSocket({ 'card:update': () => st.reload(true), 'member:update': () => st.reload(true) });
  const setStatus = async (status) => {
    const reason = status === 'ACTIVE' ? true : await confirm({ title: `${status === 'DELETED' ? 'Delete' : 'Suspend / block'} member`, reason: true, danger: true, message: status === 'DELETED' ? 'The member record is soft-deleted; transactions stay in the ledger.' : '' });
    if (!reason) return;
    await run(() => api.post(`/members/${id}/status`, { status, reason: reason === true ? undefined : reason }), { success: 'Updated' });
    if (status === 'DELETED') nav('/members'); else st.reload();
  };
  return (
    <Async state={st}>{(m) => (
      <div>
        <PageHeader title={`${m.firstName} ${m.lastName}`} subtitle={<span><code>{m.memberCode}</code> · {m.phone} · joined {date(m.joinDate)} · <StatusBadge status={m.status} /></span>}
          actions={<>
            {can('pos.open') && <Button icon={ShoppingCart} onClick={() => nav('/topup')}>Top up</Button>}
            {can('member.edit') && <Button icon={Pencil} onClick={() => setEdit(true)}>Edit</Button>}
            {can('member.reset_pin') && <Button icon={KeyRound} onClick={() => setPin('')}>Reset PIN</Button>}
            {can('member.suspend') && (m.status === 'ACTIVE' ? <Button icon={Ban} onClick={() => setStatus('SUSPENDED')}>Suspend</Button> : <Button icon={CheckCircle2} onClick={() => setStatus('ACTIVE')}>Activate</Button>)}
            {can('member.delete') && <Button variant="ghost" icon={Trash2} onClick={() => setStatus('DELETED')}>Delete</Button>}
          </>} />
        <div className="grid g4">
          <Card><div className="stat"><span className="label">Tier</span><span className="value" style={{ color: m.tier?.color }}>{m.tier?.name || '—'}</span>{m.nextTier && <span className="sub">Next: {m.nextTier.name}</span>}{m.tierLocked && <Badge>manual</Badge>}</div></Card>
          <Card><div className="stat"><span className="label">Balance (active cards)</span><span className="value">{money(m.balance)}</span></div></Card>
          <Card><div className="stat"><span className="label">Points / Stamps</span><span className="value">{int(m.points)} / {int(m.stamps)}</span><span className="sub">Lifetime {int(m.lifetimePoints)} pts · {int(m.lifetimeStamps)} stamps</span></div></Card>
          <Card><div className="stat"><span className="label">Spend / Top-up</span><span className="value">{money(m.totalSpend)}</span><span className="sub">Top-up {money(m.totalTopup)} · {int(m.totalPlay)} plays · {int(m.visitCount)} visits</span></div></Card>
        </div>
        <div className="grid g2 mt" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)' }}>
          <div className="col">
            <Card title="Profile"><Kv items={[['Nickname', m.nickname], ['Email', m.email], ['Birthday', date(m.birthday)], ['Gender', m.gender], ['Address', m.address], ['Language', m.language], ['Has PIN', m.hasPin ? 'Yes' : 'No'], ['Note', m.note],
              ...Object.entries(m.customFields || {}).map(([k, v]) => [k, String(v)]), m.blockReason && ['Block reason', m.blockReason]]} /></Card>
            <Card title="Cards">{m.cards.length === 0 ? <div className="muted small">No cards. Issue one at the POS.</div> : m.cards.map((c) => (
              <Link key={c.id} to={`/cards/${c.id}`} className="row between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', color: 'inherit' }}>
                <span className="row"><CreditCard size={18} /><span className="mono">{c.cardNumber}</span></span><StatusBadge status={c.status} /><b className="num">{money(c.balance)}</b></Link>))}</Card>
          </div>
          <Card>
            <Tabs tabs={[{ value: 'activity', label: 'Activity timeline' }, { value: 'rewards', label: 'Redemptions' }, { value: 'privacy', label: 'Privacy consents' }]} value={tab} onChange={setTab} />
            {tab === 'activity' && <Timeline path={`/members/${id}/timeline`} />}
            {tab === 'rewards' && <Table columns={[{ key: 'code', label: 'Code', render: (r) => <code>{r.code}</code> }, { key: 'reward_name', label: 'Reward' }, { label: 'Cost', render: (r) => `${r.points} pts / ${r.stamps} stamps` }, { label: 'Status', render: (r) => <StatusBadge status={r.status} /> }, { label: 'Date', render: (r) => dt(r.created_at) }]} rows={reds.data?.items || []} />}
            {tab === 'privacy' && <Table columns={[{ key: 'kind', label: 'Policy' }, { key: 'version', label: 'Version' }, { key: 'language', label: 'Lang' }, { label: 'Accepted', render: (r) => dt(r.accepted_at) }]} rows={cons.data?.items || []} />}
          </Card>
        </div>
        <EntityForm open={edit} title="Edit member" onClose={(s) => { setEdit(false); if (s) st.reload(); }}
          initial={{ phone: m.phone, firstName: m.firstName, lastName: m.lastName, nickname: m.nickname, email: m.email, birthday: m.birthday, gender: m.gender, address: m.address, note: m.note, tierId: m.tierId }}
          fields={[{ name: 'phone', label: 'Phone', required: true }, { name: 'firstName', label: 'First name', required: true }, { name: 'lastName', label: 'Last name', required: true }, { name: 'nickname', label: 'Nickname' }, { name: 'email', label: 'Email' },
            { name: 'birthday', label: 'Birthday', type: 'date' }, { name: 'gender', label: 'Gender', type: 'select', options: ['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED'].map((v) => ({ value: v, label: v })) },
            ...(can('member.suspend') ? [{ name: 'tierId', label: 'Tier (manual override locks auto-upgrade)', type: 'select', options: (tiers.data?.items || []).map((t) => ({ value: t.id, label: t.name })) }] : []),
            { name: 'address', label: 'Address', type: 'textarea', full: true }, { name: 'note', label: 'Note', type: 'textarea', full: true }]}
          onSubmit={(f) => { const body = Object.fromEntries(Object.entries(f).filter(([k, v]) => v !== undefined && v !== null && !(k === 'tierId' && v === m.tierId))); return api.put(`/members/${id}`, body); }} />
        <Modal open={pin !== null} title="Reset member PIN" onClose={() => setPin(null)} footer={<Button variant="primary" disabled={!/^\d{6}$/.test(pin || '')} onClick={() => run(() => api.post(`/members/${id}/reset-pin`, { pin }), { success: 'PIN reset — member sessions signed out' }).then(() => setPin(null))}>Set new PIN</Button>}>
          <Input label="New 6-digit PIN" type="password" inputMode="numeric" maxLength={6} value={pin || ''} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} autoFocus />
        </Modal>
      </div>
    )}</Async>
  );
}
