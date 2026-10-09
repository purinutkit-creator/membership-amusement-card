import { useEffect, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Button, PageHeader, useLoad, Card, Input, useAction, Badge, useConfirm, Skeleton } from '../../components/ui.jsx';

export default function Roles() {
  const roles = useLoad(() => api.get('/roles'), []);
  const cat = useLoad(() => api.get('/permissions'), []);
  const [sel, setSel] = useState(null);
  const [draft, setDraft] = useState(null);
  const [run, busy] = useAction();
  const confirm = useConfirm();
  useEffect(() => { if (roles.data && !sel) setSel(roles.data.items[0]?.id); }, [roles.data, sel]);
  useEffect(() => { const r = roles.data?.items.find((x) => x.id === sel); if (r) setDraft({ ...r, permissions: new Set(r.permissions) }); }, [sel, roles.data]);
  if (!roles.data || !cat.data) return <Skeleton rows={8} />;
  const toggle = (code) => { const p = new Set(draft.permissions); p.has(code) ? p.delete(code) : p.add(code); setDraft({ ...draft, permissions: p }); };
  const toggleModule = (mod, on) => { const p = new Set(draft.permissions); Object.keys(cat.data.catalog[mod]).forEach((a) => (on ? p.add(`${mod}.${a}`) : p.delete(`${mod}.${a}`))); setDraft({ ...draft, permissions: p }); };
  const save = () => run(() => (draft.id ? api.put(`/roles/${draft.id}`, { name: draft.name, description: draft.description || '', maxDiscountPct: Number(draft.max_discount_pct || 0), permissions: [...draft.permissions] })
    : api.post('/roles', { code: draft.code, name: draft.name, description: draft.description || '', maxDiscountPct: Number(draft.max_discount_pct || 0), permissions: [...draft.permissions] })), { success: 'Role saved' }).then((r) => { roles.reload(); if (r?.id) setSel(r.id); });
  const isOwnerRole = draft?.code === 'OWNER';
  return (
    <div>
      <PageHeader title="Roles & Permissions" subtitle="Per-module, per-action permissions. Owner controls who can sell, top up, refund, adjust, issue cards, export, change settings…" actions={<Button icon={Plus} onClick={() => { setSel(null); setDraft({ code: '', name: '', max_discount_pct: 0, permissions: new Set() }); }}>Custom role</Button>} />
      <div className="grid" style={{ gridTemplateColumns: 'minmax(200px, 260px) 1fr', alignItems: 'start' }}>
        <div className="card tight col gap-s">{roles.data.items.map((r) => <button key={r.id} type="button" className={`nav-link ${sel === r.id ? 'active' : ''}`} style={{ border: 0, background: sel === r.id ? undefined : 'none', cursor: 'pointer', justifyContent: 'space-between' }} onClick={() => setSel(r.id)}><span>{r.name}</span><span className="row gap-s">{r.is_system && <Badge>system</Badge>}<Badge>{r.staff_count}</Badge></span></button>)}</div>
        {draft && <Card>
          <div className="grid g3">
            {!draft.id && <Input label="Code (UPPER_CASE)" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} />}
            <Input label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} disabled={isOwnerRole} />
            <Input label="Max discount %" type="number" value={draft.max_discount_pct} onChange={(e) => setDraft({ ...draft, max_discount_pct: e.target.value })} disabled={isOwnerRole} />
          </div>
          {isOwnerRole && <div className="alert mt">The Owner role always has every permission.</div>}
          <div className="grid g3 mt">{Object.entries(cat.data.catalog).map(([mod, actions]) => {
            const all = Object.keys(actions).every((a) => draft.permissions.has(`${mod}.${a}`));
            return (
              <div key={mod} className="card tight">
                <label className="check bold"><input type="checkbox" checked={all} disabled={isOwnerRole} onChange={(e) => toggleModule(mod, e.target.checked)} />{mod}</label>
                {Object.entries(actions).map(([a, label]) => <label key={a} className="check small" style={{ minHeight: 28, paddingLeft: 12 }}><input type="checkbox" disabled={isOwnerRole} checked={draft.permissions.has(`${mod}.${a}`)} onChange={() => toggle(`${mod}.${a}`)} />{label}</label>)}
              </div>);
          })}</div>
          {!isOwnerRole && <div className="row mt"><Button variant="primary" icon={Save} loading={busy} onClick={save}>Save role</Button>
            {draft.id && !draft.is_system && <Button variant="ghost" icon={Trash2} onClick={async () => { if (await confirm({ title: 'Delete role', danger: true, message: draft.name })) run(() => api.del(`/roles/${draft.id}`), { success: 'Deleted' }).then(() => { setSel(null); roles.reload(); }); }}>Delete</Button>}</div>}
        </Card>}
      </div>
    </div>
  );
}
