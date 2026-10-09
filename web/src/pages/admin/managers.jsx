// Reusable management lists embedded in Settings / Setup Wizard.
import { EntityPage } from '../../components/entity.jsx';
import { Badge, useLoad, Button, useAction } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { money } from '../../lib/format.js';
import { RefreshCw } from 'lucide-react';

export function TiersManager() {
  const [run, busy] = useAction();
  const num = (name, label) => ({ name, label, type: 'number', min: 0 });
  return (
    <EntityPage title="Member tiers" subtitle="Unlimited tiers; members auto-upgrade when they qualify" path="/tiers" paged={false} managePerm="settings.edit" singular="tier"
      headerActions={(reload) => <Button icon={RefreshCw} loading={busy} onClick={() => run(() => api.post('/tiers/recalculate'), { success: (r) => `Checked ${r.checked}, changed ${r.changed}` }).then(reload)}>Recalculate tiers</Button>}
      columns={[
        { key: 'rank', label: 'Rank', num: true }, { label: 'Tier', render: (r) => <span className="row"><span className="dot" style={{ background: r.color }} /> <b>{r.name}</b> <code className="xs">{r.code}</code></span> },
        { label: 'Qualification', render: (r) => Object.entries(r.qualification || {}).filter(([k]) => k !== 'mode').map(([k, v]) => `${k.replace('min', '≥ ')} ${v}`).join(` ${r.qualification?.mode || 'ANY'} `) || 'Base tier' },
        { label: 'Benefits', render: (r) => <span className="small">{[r.benefits?.topupBonusPct && `+${r.benefits.topupBonusPct}% top-up`, r.benefits?.discountPct && `${r.benefits.discountPct}% discount`, r.benefits?.pointMultiplier && `x${r.benefits.pointMultiplier} pts`, r.benefits?.stampMultiplier && `x${r.benefits.stampMultiplier} stamps`, r.benefits?.birthdayPoints && `🎂 ${r.benefits.birthdayPoints} pts`].filter(Boolean).join(' · ')}</span> },
        { key: 'member_count', label: 'Members', num: true }, { label: 'Status', render: (r) => <Badge tone={r.status === 'ACTIVE' ? 'success' : ''}>{r.status}</Badge> },
      ]}
      fields={[
        { name: 'code', label: 'Code', required: true, upper: true }, { name: 'name', label: 'Name', required: true }, { name: 'rank', label: 'Rank (0 = base)', type: 'number', required: true, min: 0 },
        { name: 'color', label: 'Color', type: 'color', required: true }, { name: 'iconMediaId', label: 'Tier icon', type: 'media', category: 'TIER_ICON' },
        { name: 'c1', label: 'Digital card gradient start', type: 'color' }, { name: 'c2', label: 'Digital card gradient end', type: 'color' },
        { name: 'mode', label: 'Qualify when', type: 'select', options: [{ value: 'ANY', label: 'ANY condition met' }, { value: 'ALL', label: 'ALL conditions met' }] },
        num('minPoints', 'Lifetime points ≥'), num('minStamps', 'Lifetime stamps ≥'), num('minSpend', 'Total spend ≥ ฿'), num('minTopup', 'Total top-up ≥ ฿'), num('minVisits', 'Visits ≥'), num('minPlays', 'Plays ≥'),
        num('topupBonusPct', 'Benefit: top-up bonus %'), num('discountPct', 'Benefit: food/product discount %'), { name: 'pointMultiplier', label: 'Benefit: point multiplier', type: 'number', step: '0.1', min: 0 },
        { name: 'stampMultiplier', label: 'Benefit: stamp multiplier', type: 'number', step: '0.1', min: 0 }, num('birthdayPoints', 'Birthday reward points'), num('birthdayStamps', 'Birthday reward stamps'),
        { name: 'description', label: 'Benefit description', type: 'textarea', full: true }, { name: 'status', label: 'Status', type: 'select', options: [{ value: 'ACTIVE', label: 'Active' }, { value: 'INACTIVE', label: 'Inactive' }] },
      ]}
      defaults={{ color: '#9CA3AF', mode: 'ANY', status: 'ACTIVE', rank: 0 }}
      toForm={(r) => ({ ...r, iconMediaId: r.icon_media_id, ...r.qualification, ...r.benefits, c1: r.card_theme?.c1, c2: r.card_theme?.c2 })}
      toPayload={(f) => {
        const n = (v) => (v === '' || v == null ? undefined : Number(v));
        return {
          code: f.code, name: f.name, rank: Number(f.rank), color: f.color, iconMediaId: f.iconMediaId || null, status: f.status || 'ACTIVE', cardTheme: { c1: f.c1, c2: f.c2 },
          qualification: { mode: f.mode || 'ANY', minPoints: n(f.minPoints), minStamps: n(f.minStamps), minSpend: n(f.minSpend), minTopup: n(f.minTopup), minVisits: n(f.minVisits), minPlays: n(f.minPlays) },
          benefits: { topupBonusPct: n(f.topupBonusPct), discountPct: n(f.discountPct), pointMultiplier: n(f.pointMultiplier), stampMultiplier: n(f.stampMultiplier), birthdayPoints: n(f.birthdayPoints), birthdayStamps: n(f.birthdayStamps), description: f.description || undefined },
        };
      }}
    />
  );
}

export function StampRulesManager() {
  const machines = useLoad(() => api.get('/machines?pageSize=200'), []);
  const cats = useLoad(() => api.get('/machine-categories'), []);
  return (
    <EntityPage title="Stamp rules" subtitle="e.g. play premium = 3 stamps · food ฿100 = 1 stamp · top up ฿500 = 5 stamps" path="/stamp-rules" paged={false} managePerm="settings.edit" singular="stamp rule"
      columns={[{ key: 'name', label: 'Rule' }, { key: 'event', label: 'Event' }, { label: 'Scope', render: (r) => r.machine_name || r.category_name || 'All' }, { label: 'Condition', render: (r) => `${r.min_amount > 0 ? `≥ ${money(r.min_amount)}` : ''} ${r.per_amount ? `per ${money(r.per_amount)}` : ''}` },
        { key: 'stamps', label: 'Stamps', num: true }, { label: 'Status', render: (r) => <Badge tone={r.status === 'ACTIVE' ? 'success' : ''}>{r.status}</Badge> }]}
      fields={[{ name: 'name', label: 'Name', required: true }, { name: 'event', label: 'Event', type: 'select', required: true, options: ['PLAY', 'FOOD', 'TOP_UP'].map((v) => ({ value: v, label: v })) },
        { name: 'machineId', label: 'Machine (optional)', type: 'select', show: (f) => f.event === 'PLAY', options: (machines.data?.items || []).map((m) => ({ value: m.id, label: m.name })) },
        { name: 'categoryId', label: 'Category (optional)', type: 'select', show: (f) => f.event === 'PLAY', options: (cats.data?.items || []).map((c) => ({ value: c.id, label: c.name })) },
        { name: 'minAmount', label: 'Minimum amount ฿', type: 'money', min: 0 }, { name: 'perAmount', label: 'Per amount ฿ (stamps × floor(amount/per))', type: 'money', min: 0 },
        { name: 'stamps', label: 'Stamps', type: 'number', required: true, min: 1 }, { name: 'status', label: 'Status', type: 'select', options: [{ value: 'ACTIVE', label: 'Active' }, { value: 'INACTIVE', label: 'Inactive' }] }]}
      defaults={{ event: 'PLAY', stamps: 1, minAmount: 0, status: 'ACTIVE' }}
      toForm={(r) => ({ name: r.name, event: r.event, machineId: r.machine_id, categoryId: r.category_id, minAmount: r.min_amount, perAmount: r.per_amount, stamps: r.stamps, status: r.status })}
      toPayload={(f) => ({ ...f, machineId: f.machineId || null, categoryId: f.categoryId || null, perAmount: f.perAmount || null, minAmount: Number(f.minAmount || 0), stamps: Number(f.stamps) })}
    />
  );
}

export function BranchesManager() {
  return (
    <EntityPage title="Branches" subtitle="Multi-branch: each branch can override settings (Settings → choose branch)" path="/branches" paged={false} managePerm="branch.manage" singular="branch" deletable={false}
      columns={[{ key: 'code', label: 'Code', render: (r) => <code>{r.code}</code> }, { key: 'name', label: 'Name' }, { key: 'phone', label: 'Phone' }, { key: 'tax_id', label: 'Tax ID' }, { key: 'timezone', label: 'Timezone' }, { key: 'currency', label: 'Currency' }, { label: 'Status', render: (r) => <Badge tone={r.status === 'ACTIVE' ? 'success' : ''}>{r.status}</Badge> }]}
      fields={[{ name: 'code', label: 'Branch code', required: true, upper: true }, { name: 'name', label: 'Name', required: true }, { name: 'logoMediaId', label: 'Logo', type: 'media', category: 'LOGO' }, { name: 'phone', label: 'Phone' }, { name: 'taxId', label: 'Tax ID' },
        { name: 'timezone', label: 'Timezone', type: 'select', options: ['Asia/Bangkok', 'Asia/Singapore', 'Asia/Kuala_Lumpur', 'Asia/Shanghai', 'UTC'].map((v) => ({ value: v, label: v })) }, { name: 'currency', label: 'Currency' },
        { name: 'status', label: 'Status', type: 'select', options: [{ value: 'ACTIVE', label: 'Active' }, { value: 'INACTIVE', label: 'Inactive' }] }, { name: 'address', label: 'Address', type: 'textarea', full: true }]}
      defaults={{ timezone: 'Asia/Bangkok', currency: 'THB', status: 'ACTIVE' }}
      toForm={(r) => ({ code: r.code, name: r.name, logoMediaId: r.logo_media_id, phone: r.phone, taxId: r.tax_id, timezone: r.timezone, currency: r.currency, status: r.status, address: r.address })}
    />
  );
}
