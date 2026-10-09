import { useState } from 'react';
import { Plug, Unplug, Printer as PrinterIcon, FileText, Wallet, Search, RefreshCw, Star } from 'lucide-react';
import { PrinterManager } from '../../lib/printer.js';
import { api } from '../../lib/api.js';
import { EntityPage } from '../../components/entity.jsx';
import { Button, Badge, Card, Modal, Input, useToast, useLoad } from '../../components/ui.jsx';
import { ReceiptView } from '../../components/domain.jsx';
import { dt } from '../../lib/format.js';
import { useAuth } from '../../lib/auth.jsx';

const SAMPLE = {
  store: { name: 'Sample Store', address: '99 Sample Rd', phone: '02-000-0000', taxId: '0105550000001' }, receiptNo: 'RCP202601010001', createdAt: new Date().toISOString(), cashier: 'Demo', orderNo: 'ORD202601010001', type: 'SALE',
  items: [{ name: 'Top Up: ฿500 + Bonus ฿80', qty: 1, unitPrice: 500, total: 500, bonus: 80, card: '****9012' }, { name: 'ผัดไทย Pad Thai', qty: 2, unitPrice: 89, total: 178 }],
  totals: { subtotal: 678, discount: 0, service: 0, vat: 11.64, vatMode: 'INCLUSIVE', vatRate: 7, grandTotal: 678 }, payment: { method: 'CASH', amount: 678, received: 1000, change: 322 },
  cards: [{ number: '****9012', newBalance: 1080 }], pointsEarned: 7, stampsEarned: 1, qrToken: 'sample', thankYou: 'ขอบคุณค่ะ Thank you!',
};

export function PrinterList() {
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const [scan, setScan] = useState(false);
  const [subnet, setSubnet] = useState('192.168.1');
  const [found, setFound] = useState(null);
  const [sample, setSample] = useState(false);
  const [k, setK] = useState(0);
  const act = async (id, fn, ok) => { setBusy(id); try { await fn(); if (ok) toast.success(ok); } catch (e) { toast.error(e.message); } finally { setBusy(null); setK((x) => x + 1); } };
  const local = localStorage.getItem('sc.printer.RECEIPT');
  return (
    <>
      <EntityPage key={k} title="Printers" subtitle="USB (WebUSB) · Bluetooth/BLE · Serial · LAN / network (Local Print Bridge, ESC/POS) · Browser printing" path="/printers" paged={false} managePerm="printer.manage" singular="printer"
        headerActions={() => <><Button icon={Search} onClick={() => setScan(true)}>Search LAN printers</Button><Button icon={FileText} onClick={() => setSample(true)}>Sample receipt</Button></>}
        extraActions={(r) => <>
          {!PrinterManager.supported(r.connection) ? <Badge tone="warning">unsupported here</Badge> : PrinterManager.isConnected(r.id) || r.connection === 'BROWSER'
            ? <Button size="sm" icon={Unplug} onClick={() => act(r.id, () => PrinterManager.disconnect(r), 'Disconnected')}>Disconnect</Button>
            : <Button size="sm" icon={Plug} loading={busy === r.id} onClick={() => act(r.id, () => PrinterManager.connect(r), 'Connected')}>Pair / connect</Button>}
          <Button size="sm" icon={PrinterIcon} loading={busy === r.id} onClick={() => act(r.id, () => PrinterManager.testPrint(r), 'Test page sent')}>Test</Button>
          <Button size="sm" icon={RefreshCw} onClick={() => act(r.id, () => PrinterManager.reconnect(r), 'Reconnected')} aria-label="Reconnect" />
          {r.cash_drawer && <Button size="sm" icon={Wallet} onClick={() => act(r.id, () => PrinterManager.openDrawer(r), 'Drawer opened')}>Drawer</Button>}
          <Button size="sm" variant={local === r.id ? 'primary' : 'ghost'} icon={Star} onClick={() => { localStorage.setItem(`sc.printer.${r.purpose}`, r.id); setK((x) => x + 1); toast.success('Default printer for this device'); }} aria-label="Use on this device" />
        </>}
        columns={[{ label: 'Printer', render: (r) => <><b>{r.name}</b>{r.is_default && <Badge tone="primary">default</Badge>}<div className="xs muted">{r.branch_name} {r.address && `· ${r.address}`}</div></> }, { key: 'connection', label: 'Connection', render: (r) => <Badge>{r.connection}</Badge> },
          { label: 'Paper', render: (r) => `${r.paper_width}${r.paper_width === 'A4' ? '' : 'mm'}` }, { key: 'purpose', label: 'Purpose' }, { label: 'Cut / feed', render: (r) => `${r.cut_mode} / ${r.feed_lines}` },
          { label: 'Status', render: (r) => <><Badge tone={r.status === 'CONNECTED' ? 'success' : r.status === 'ERROR' ? 'danger' : ''}>{PrinterManager.isConnected(r.id) ? 'CONNECTED' : r.status}</Badge><div className="xs faint">{dt(r.last_seen_at)}</div></> }]}
        fields={[{ name: 'name', label: 'Name', required: true }, { name: 'connection', label: 'Connection', type: 'select', required: true, options: [['BROWSER', 'Browser printing (any printer)'], ['WEBUSB', 'USB (WebUSB, ESC/POS)'], ['WEB_BLUETOOTH', 'Bluetooth / BLE (ESC/POS)'], ['WEB_SERIAL', 'Serial / Bluetooth SPP (ESC/POS)'], ['LAN', 'LAN / network (ESC/POS via Local Print Bridge)'], ['BRIDGE', 'Local Print Bridge']].map(([value, label]) => ({ value, label })) },
          { name: 'address', label: 'Network address (ip:9100)', show: (f) => ['LAN', 'BRIDGE'].includes(f.connection) }, { name: 'paperWidth', label: 'Paper width', type: 'select', options: [['58', '58 mm'], ['80', '80 mm'], ['A4', 'A4']].map(([value, label]) => ({ value, label })) },
          { name: 'purpose', label: 'Purpose', type: 'select', options: ['RECEIPT', 'LABEL', 'A4'].map((v) => ({ value: v, label: v })) }, { name: 'cutMode', label: 'Cut mode', type: 'select', options: ['NONE', 'PARTIAL', 'FULL'].map((v) => ({ value: v, label: v })) },
          { name: 'feedLines', label: 'Feed lines', type: 'number', min: 0 }, { name: 'cashDrawer', label: 'Cash drawer attached', type: 'switch' }, { name: 'isDefault', label: 'Default printer', type: 'switch' }, { name: 'baudRate', label: 'Baud rate (serial)', type: 'number', show: (f) => f.connection === 'WEB_SERIAL' }]}
        defaults={{ connection: 'BROWSER', paperWidth: '80', purpose: 'RECEIPT', cutMode: 'PARTIAL', feedLines: 3, cashDrawer: false, isDefault: false }}
        toForm={(r) => ({ name: r.name, connection: r.connection, address: r.address, paperWidth: r.paper_width, purpose: r.purpose, cutMode: r.cut_mode, feedLines: r.feed_lines, cashDrawer: r.cash_drawer, isDefault: r.is_default, baudRate: r.config?.baudRate })}
        toPayload={(f) => ({ name: f.name, connection: f.connection, address: f.address || undefined, paperWidth: f.paperWidth, protocol: f.connection === 'BROWSER' ? 'BROWSER' : 'ESCPOS', purpose: f.purpose, cutMode: f.cutMode, feedLines: Number(f.feedLines ?? 3), cashDrawer: !!f.cashDrawer, isDefault: !!f.isDefault, config: f.baudRate ? { baudRate: Number(f.baudRate) } : {} })} />
      <Modal open={scan} title="Search LAN printers (port 9100)" onClose={() => { setScan(false); setFound(null); }}>
        <div className="col"><div className="small muted">Requires the Local Print Bridge running on this computer: <code>node bridge/print-bridge.mjs</code></div>
          <div className="row"><Input className="grow" label="Subnet" value={subnet} onChange={(e) => setSubnet(e.target.value)} /><Button icon={Search} loading={busy === 'scan'} onClick={() => act('scan', async () => setFound((await PrinterManager.bridgeScan(subnet)).printers))}>Scan</Button></div>
          {found && (found.length ? found.map((p) => <div key={p} className="row between"><code>{p}</code><Button size="sm" onClick={() => act('add', () => api.post('/printers', { name: `LAN ${p}`, connection: 'LAN', address: p, paperWidth: '80', protocol: 'ESCPOS' }), 'Printer added')}>Add</Button></div>) : <div className="muted">No printers found.</div>)}</div>
      </Modal>
      <Modal open={sample} title="Sample receipt" onClose={() => setSample(false)} footer={<Button icon={PrinterIcon} onClick={() => PrinterManager.printReceipt(null, SAMPLE, { elementId: 'receipt-print' })}>Print via browser</Button>}><ReceiptView data={SAMPLE} /></Modal>
    </>
  );
}

export default function Printers() {
  const { settings } = useAuth();
  const r = settings?.receipt;
  return <div className="col"><PrinterList />{r && <Card><div className="small">Receipt layout & content: Settings → Receipt (paper {r.paperWidth}, {r.copies} copies, auto print {r.autoPrint ? 'on' : 'off'}).</div></Card>}</div>;
}
