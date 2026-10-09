import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Plus, Download, Printer, Upload } from 'lucide-react';
import { api, download } from '../../lib/api.js';
import { money, int, dt, groupCard } from '../../lib/format.js';
import { Button, PageHeader, PagedTable, usePaged, useDebounced, StatusBadge, Tabs, Modal, Input, Textarea, Chips, useAction, Select, useLoad, Badge } from '../../components/ui.jsx';
import { CardScanInput, Barcode, QR } from '../../components/domain.jsx';
import { browserPrint } from '../../lib/printer.js';
import { useAuth } from '../../lib/auth.jsx';

export function LabelSheet({ cards, layout = 'sheet' }) {
  return (
    <div id="label-print" className={layout === 'sheet' ? 'label-sheet' : ''} style={{ background: '#fff' }}>
      {cards.map((c) => (
        <div key={c.card_number} className={`lbl ${layout === "thermal" ? "thermal" : ""}`}>
          <Barcode value={c.card_number} height={34} width={1.3} displayValue={false} />
          <div className="mono" style={{ fontSize: '9pt' }}>{groupCard(c.card_number)}</div>
          {c.portalUrl && <QR value={c.portalUrl} size={56} />}
        </div>
      ))}
    </div>
  );
}

export function PrintLabelsModal({ open, onClose, cards }) {
  const [layout, setLayout] = useState('sheet');
  return (
    <Modal open={open} title={`Print labels (${cards.length})`} onClose={onClose} size="xwide" footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" icon={Printer} onClick={() => browserPrint('label-print')}>Print</Button></>}>
      <Chips options={[{ value: 'sheet', label: 'Label sheet (A4, 3×7)' }, { value: 'thermal', label: 'Thermal label 50×30mm' }]} value={layout} onChange={setLayout} />
      <div className="mt" style={{ maxHeight: '60vh', overflow: 'auto', border: '1px solid var(--border)' }}><LabelSheet cards={cards} layout={layout} /></div>
    </Modal>
  );
}

function CreateCards({ open, onClose }) {
  const [mode, setMode] = useState('auto');
  const [count, setCount] = useState(100);
  const [type, setType] = useState('MEMBER');
  const [prefix, setPrefix] = useState('');
  const [numbers, setNumbers] = useState('');
  const [run, busy] = useAction();
  const submit = async () => {
    let r;
    if (mode === 'auto') r = await run(() => api.post('/cards', { count: Number(count), cardType: type, prefix: prefix || undefined }), { success: (x) => `${x.count} cards created` });
    else if (mode === 'manual') r = await run(() => api.post('/cards', { numbers: numbers.split(/[\s,]+/).filter(Boolean), cardType: type }), { success: (x) => `${x.count} cards created` });
    else r = await run(() => api.post('/cards/import', { csv: numbers, cardType: type }), { success: (x) => `${x.count} cards imported` });
    onClose(r);
  };
  return (
    <Modal open={open} title="Create cards" onClose={() => onClose(null)} footer={<><Button onClick={() => onClose(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Create</Button></>}>
      <div className="col">
        <Chips options={[{ value: 'auto', label: 'Auto generate' }, { value: 'manual', label: 'Manual numbers' }, { value: 'csv', label: 'Import CSV' }]} value={mode} onChange={setMode} />
        <Select label="Card type" value={type} onChange={(e) => setType(e.target.value)} options={[{ value: 'MEMBER', label: 'Member card' }, { value: 'GUEST', label: 'Guest / temporary card' }]} />
        {mode === 'auto' && <><Chips options={[100, 500, 1000].map((n) => ({ value: n, label: String(n) }))} value={Number(count)} onChange={setCount} />
          <Input label="Quantity (1–5000)" type="number" value={count} onChange={(e) => setCount(e.target.value)} />
          <Input label="Prefix (optional, digits)" value={prefix} maxLength={6} onChange={(e) => setPrefix(e.target.value.replace(/\D/g, ''))} hint="Numbers are 12 digits with a Luhn check digit; uniqueness enforced by the database." /></>}
        {mode === 'manual' && <Textarea label="12-digit card numbers (space / comma / newline separated)" value={numbers} onChange={(e) => setNumbers(e.target.value)} />}
        {mode === 'csv' && <><Textarea label="CSV: card_number[,rfid_uid] per line" value={numbers} onChange={(e) => setNumbers(e.target.value)} />
          <input type="file" accept=".csv,.txt" onChange={async (e) => setNumbers(await e.target.files[0].text())} /></>}
      </div>
    </Modal>
  );
}

export default function Cards() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [tab, setTab] = useState('cards');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [create, setCreate] = useState(false);
  const [labels, setLabels] = useState(null);
  const dq = useDebounced(q);
  const st = usePaged('/cards', { q: dq, status, type });
  const batches = useLoad(() => (tab === 'batches' ? api.get('/cards/batches?pageSize=100') : Promise.resolve(null)), [tab]);
  const printBatch = async (b) => {
    const csv = await (await fetch(`/api/cards/batches/${b.id}/export`, { headers: { 'X-Requested-With': 'smartcard' } })).text();
    const rows = csv.replace(/^﻿/, '').split('\n').slice(1).filter(Boolean).map((l) => { const [n, , url] = l.split(','); return { card_number: n, portalUrl: url }; });
    setLabels(rows);
  };
  return (
    <div>
      <PageHeader title="Cards" subtitle="12-digit smart cards — member & guest" actions={can('card.batch') && <><Button variant="primary" icon={Plus} onClick={() => setCreate(true)}>Create / import cards</Button></>} />
      <Tabs tabs={[{ value: 'cards', label: 'Cards' }, { value: 'find', label: 'Identify card' }, ...(can('card.batch') ? [{ value: 'batches', label: 'Batches' }] : [])]} value={tab} onChange={setTab} />
      {tab === 'find' && <div className="card" style={{ maxWidth: 700 }}><CardScanInput onCard={(c) => nav(`/cards/${c.id}`)} /></div>}
      {tab === 'cards' && <>
        <div className="toolbar">
          <div className="search-box"><Search size={18} /><input className="input" placeholder="Card number, RFID, member phone or name" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['ACTIVE', 'INACTIVE', 'BLOCKED', 'LOST', 'EXPIRED', 'REPLACED'].map((s) => <option key={s}>{s}</option>)}</select>
          <select className="input" value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option><option value="MEMBER">Member</option><option value="GUEST">Guest</option></select>
        </div>
        <PagedTable state={st} onRowClick={(r) => nav(`/cards/${r.id}`)} columns={[
          { label: 'Card number', render: (r) => <span className="mono bold nowrap">{groupCard(r.card_number)}</span> }, { key: 'card_type', label: 'Type' },
          { label: 'Member', render: (r) => (r.member_code ? `${r.first_name} ${r.last_name} (${r.member_code})` : <span className="faint">—</span>) },
          { label: 'Balance', num: true, render: (r) => money(r.balance) }, { label: 'Points', num: true, render: (r) => int(r.points) }, { label: 'Stamps', num: true, render: (r) => int(r.stamps) },
          { label: 'Last used', render: (r) => dt(r.last_used_at) }, { label: 'Batch', render: (r) => r.batch_no && <code className="xs">{r.batch_no}</code> }, { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
        ]} />
      </>}
      {tab === 'batches' && (
        <div className="card pad-0"><table className="table"><thead><tr><th>Batch</th><th>Type</th><th className="num">Qty</th><th className="num">Issued</th><th>Created</th><th /></tr></thead>
          <tbody>{(batches.data?.items || []).map((b) => (
            <tr key={b.id}><td><code>{b.batch_no}</code> {b.note && <span className="xs muted">{b.note}</span>}</td><td><Badge>{b.card_type}</Badge></td><td className="num">{b.quantity}</td><td className="num">{b.issued}</td><td>{dt(b.created_at)} · {b.created_by_name}</td>
              <td className="right"><div className="row" style={{ justifyContent: 'flex-end' }}><Button size="sm" icon={Download} onClick={() => download(`/cards/batches/${b.id}/export`, `${b.batch_no}.csv`)}>CSV</Button>
                <Button size="sm" icon={Printer} onClick={() => printBatch(b)}>Labels</Button><Button size="sm" onClick={() => { setTab('cards'); }}>View</Button></div></td></tr>))}</tbody></table></div>
      )}
      <CreateCards open={create} onClose={(r) => { setCreate(false); if (r) { st.reload(); batches.reload(); } }} />
      <PrintLabelsModal open={!!labels} cards={labels || []} onClose={() => setLabels(null)} />
      <span hidden><Upload /></span>
    </div>
  );
}
