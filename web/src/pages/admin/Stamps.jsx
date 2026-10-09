import { useState } from 'react';
import { Stamp, Minus, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api.js';
import { int } from '../../lib/format.js';
import { Button, PageHeader, Card, Input, useAction, Chips, useLoad, Select } from '../../components/ui.jsx';
import { CardScanInput, CardChip } from '../../components/domain.jsx';
import { useAuth } from '../../lib/auth.jsx';

/** Quick loyalty action page: find card -> add / remove stamps or points. Mobile friendly. */
export function LoyaltyQuick({ kind }) {
  const { can, settings } = useAuth();
  const [card, setCard] = useState(null);
  const [custom, setCustom] = useState('');
  const [reason, setReason] = useState('');
  const [machineId, setMachineId] = useState('');
  const [last, setLast] = useState(null);
  const [run, busy] = useAction();
  const machines = useLoad(() => (kind === 'stamps' ? api.get('/machines?pageSize=200').catch(() => ({ items: [] })) : Promise.resolve({ items: [] })), []);
  const isStamp = kind === 'stamps';
  const name = isStamp ? settings?.stamp?.name || 'Stamp' : 'Points';
  const apply = async (delta) => {
    const body = { delta, reason: reason || (isStamp ? 'Stamp issued' : 'Points issued'), ...(isStamp && machineId ? { machineId } : {}) };
    const r = await run(() => api.post(`/cards/${card.id}/${kind}`, body), { success: `${delta > 0 ? '+' : ''}${delta} ${name} recorded` });
    setCard(r.card); setLast({ delta, txn: r.txnNo, converted: r.converted }); setCustom('');
  };
  const canRemove = can(isStamp ? 'stamp.remove' : 'point.remove') || can(isStamp ? 'stamp.adjust' : 'point.adjust');
  return (
    <div style={{ maxWidth: 760 }}>
      <PageHeader title={isStamp ? name : 'Points'} subtitle={`Tap / scan / QR / type the card, then add ${name.toLowerCase()}`} />
      <Card>{card ? <CardChip card={card} onClear={() => { setCard(null); setLast(null); }} /> : <CardScanInput onCard={setCard} />}</Card>
      {card && (
        <Card className="mt">
          <div className="center"><div className="muted">Current {name}</div><div className="giant num">{int(isStamp ? card.stamps : card.points)}</div>
            {last && <div className="alert success" style={{ justifyContent: 'center' }}>{last.delta > 0 ? '+' : ''}{last.delta} recorded · {last.txn}{last.converted && ' · auto-converted to points'}</div>}</div>
          {isStamp && machines.data?.items.length > 0 && <Select label="Activity / machine (optional)" value={machineId} onChange={(e) => setMachineId(e.target.value)} placeholder="—" options={machines.data.items.map((m) => ({ value: m.id, label: m.name }))} />}
          <div className="grid g4 mt">{[1, 2, 5, 10].map((n) => <Button key={n} variant="primary" size="xl" loading={busy} onClick={() => apply(n)} icon={isStamp ? Stamp : undefined}>+{n}</Button>)}</div>
          <div className="row mt"><Input className="grow" type="number" size="lg" placeholder="Custom amount" value={custom} onChange={(e) => setCustom(e.target.value)} />
            <Button size="lg" variant="primary" disabled={!(Number(custom) > 0)} onClick={() => apply(Math.trunc(Number(custom)))}>Add</Button>
            {canRemove && <Button size="lg" variant="danger" icon={Minus} disabled={!(Number(custom) > 0) || reason.length < 3} onClick={() => apply(-Math.trunc(Number(custom)))}>Remove</Button>}</div>
          <Input className="mt" label="Reason / note (required to remove)" value={reason} onChange={(e) => setReason(e.target.value)} />
          {isStamp && settings?.stamp?.conversion?.enabled && can('stamp.convert') && <Button className="mt" icon={RefreshCw} onClick={() => run(() => api.post(`/cards/${card.id}/convert-stamps`, {}), { success: 'Converted' }).then((r) => setCard(r.card))}>Convert {settings.stamp.conversion.stamps} stamps → {settings.stamp.conversion.points} points</Button>}
        </Card>
      )}
      <span hidden><Chips options={[]} /></span>
    </div>
  );
}
export default function Stamps() { return <LoyaltyQuick kind="stamps" />; }
