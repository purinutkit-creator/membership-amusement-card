// =====================================================================
// Printer Integration Layer
//  BROWSER        — renders HTML receipt and calls window.print() (works everywhere)
//  WEBUSB         — raw ESC/POS over USB bulk endpoint (Chrome/Edge)
//  WEB_BLUETOOTH  — ESC/POS over BLE printer service (common 0x18F0 / 0xFF00 services)
//  WEB_SERIAL     — ESC/POS over serial / Bluetooth-SPP COM port
//  LAN / BRIDGE   — ESC/POS sent to the Local Print Bridge (bridge/print-bridge.js on the POS
//                   machine, http://127.0.0.1:9110) which forwards to tcp://<ip>:9100.
// Status values are only set from real outcomes (device opened / bridge answered).
// =====================================================================
import { api } from './api.js';

// ---------------------------------------------------------------- ESC/POS builder
const ESC = 0x1b, GS = 0x1d;
/** Encode text for Thai ESC/POS printers (TIS-620 / CP874). Non-Thai non-ASCII -> '?'. */
export function encodeTis620(str) {
  const out = [];
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c >= 0x0e01 && c <= 0x0e5b) out.push(c - 0x0e00 + 0xa0);
    else if (c === 0x0e3f) out.push(0xdf);
    else out.push(0x3f);
  }
  return out;
}

export class EscPos {
  constructor({ width = 80, codepage = 255 } = {}) { this.bytes = []; this.cols = width === 58 || width === '58' ? 32 : 48; this.codepage = codepage; this.init(); }
  raw(...b) { this.bytes.push(...b.flat()); return this; }
  init() { return this.raw(ESC, 0x40, ESC, 0x74, this.codepage); }
  align(a) { return this.raw(ESC, 0x61, { left: 0, center: 1, right: 2 }[a] ?? 0); }
  bold(on = true) { return this.raw(ESC, 0x45, on ? 1 : 0); }
  size(w = 1, h = 1) { return this.raw(GS, 0x21, ((w - 1) << 4) | (h - 1)); }
  text(s = '') { return this.raw(encodeTis620(s)); }
  line(s = '') { return this.text(s).raw(0x0a); }
  feed(n = 1) { return this.raw(ESC, 0x64, n); }
  hr(ch = '-') { return this.line(ch.repeat(this.cols)); }
  // Thai combining vowels/tone marks take no column width
  static visualLen(s) { return [...String(s)].filter((c) => !/[ัิ-ฺ็-๎]/.test(c)).length; }
  pair(left, right) {
    const l = String(left); const r = String(right);
    const space = Math.max(1, this.cols - EscPos.visualLen(l) - EscPos.visualLen(r));
    return this.line(l + ' '.repeat(space) + r);
  }
  qr(data, size = 6) {
    const d = encodeTis620(data); const len = d.length + 3;
    return this.raw(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00, GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, size, GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31,
      GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30, d, GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30);
  }
  barcode128(data) { const d = encodeTis620(`{B${data}`); return this.raw(GS, 0x68, 80, GS, 0x77, 2, GS, 0x48, 2, GS, 0x6b, 73, d.length, d); }
  cut(mode = 'PARTIAL') { if (mode === 'NONE') return this; return this.raw(GS, 0x56, mode === 'FULL' ? 0 : 1); }
  drawer() { return this.raw(ESC, 0x70, 0, 25, 250); }
  build() { return new Uint8Array(this.bytes); }
}

const m = (n) => `${Number(n) < 0 ? '-' : ''}${Math.abs(Number(n || 0)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Receipt data snapshot (from the server) -> ESC/POS bytes. */
export function receiptToEscPos(r, { width = 80, reprint = false, cutMode = 'PARTIAL', feedLines = 3, settings = {}, publicUrl = location.origin } = {}) {
  const p = new EscPos({ width });
  p.align('center').bold().size(2, 2).line(r.store?.name || '').size(1, 1).bold(false);
  if (r.branch?.name) p.line(r.branch.name);
  if (r.store?.address) p.line(r.store.address);
  if (r.store?.phone) p.line(`Tel ${r.store.phone}`);
  if (r.store?.taxId) p.line(`TAX ID ${r.store.taxId}`);
  if (r.header) p.line(r.header);
  if (reprint && settings.showReprintLabel !== false) p.bold().line('*** REPRINT ***').bold(false);
  if (r.type === 'REFUND') p.bold().line('*** REFUND / คืนเงิน ***').bold(false);
  p.align('left').hr();
  p.pair('Receipt', r.receiptNo).pair('Date', new Date(r.createdAt).toLocaleString('en-GB'));
  if (r.orderNo) p.pair('Order', r.orderNo);
  if (r.cashier) p.pair('Cashier', r.cashier);
  if (r.member) p.pair('Member', `${r.member.code} ${r.member.phone || ''}`);
  p.hr();
  for (const i of r.items || []) {
    p.line(i.name);
    p.pair(`  ${i.qty} x ${m(i.unitPrice)}${i.card ? ` ${i.card}` : ''}`, m(i.total));
    if (i.discount) p.pair('  Discount', `-${m(i.discount)}`);
    if (i.bonus) p.pair('  Bonus credit', `+${m(i.bonus)}`);
  }
  p.hr();
  if (r.totals) {
    p.pair('Subtotal', m(r.totals.subtotal));
    if (r.totals.discount) p.pair('Discount', `-${m(r.totals.discount)}`);
    if (r.totals.service) p.pair('Service', m(r.totals.service));
    if (r.totals.vat) p.pair(`VAT ${r.totals.vatRate}%${r.totals.vatMode === 'INCLUSIVE' ? ' (incl.)' : ''}`, m(r.totals.vat));
    p.bold().size(1, 2).pair('TOTAL', m(r.totals.grandTotal)).size(1, 1).bold(false);
  }
  if (r.refundAmount != null) p.bold().pair('REFUND', m(r.refundAmount)).bold(false).line(`Reason: ${r.refundReason || ''}`);
  if (r.payment) {
    p.pair(`Paid (${r.payment.method})`, m(r.payment.amount));
    if (r.payment.received != null) p.pair('Received', m(r.payment.received));
    if (r.payment.change != null) p.pair('Change', m(r.payment.change));
  }
  for (const c of r.cards || []) p.pair(`Card ${c.number}`, `Bal ${m(c.newBalance)}`);
  if (r.pointsEarned) p.pair('Points earned', `+${r.pointsEarned}`);
  if (r.stampsEarned) p.pair('Stamps earned', `+${r.stampsEarned}`);
  for (const pr of r.promotions || []) p.line(`* ${pr.name}`);
  p.hr().align('center');
  if (settings.showQr !== false && r.qrToken) p.qr(`${publicUrl}/r/${r.qrToken}`, 5).line('Digital receipt');
  if (settings.showBarcode && r.receiptNo) p.barcode128(r.receiptNo);
  if (r.footer) p.line(r.footer);
  p.bold().line(r.thankYou || 'Thank you!').bold(false);
  p.feed(feedLines).cut(cutMode);
  return p.build();
}

// ---------------------------------------------------------------- transports
const BLE_SERVICES = ['000018f0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455'];
const BRIDGE = 'http://127.0.0.1:9110';

const transports = {
  WEBUSB: {
    supported: () => 'usb' in navigator,
    async connect(state) {
      const d = state.device || await navigator.usb.requestDevice({ filters: [{ classCode: 7 }, {}].slice(0, 1) }).catch(() => navigator.usb.requestDevice({ filters: [] }));
      await d.open();
      if (d.configuration === null) await d.selectConfiguration(1);
      const iface = d.configuration.interfaces.find((i) => i.alternate.endpoints.some((e) => e.direction === 'out' && e.type === 'bulk'));
      if (!iface) throw new Error('No bulk OUT endpoint — is this a printer?');
      await d.claimInterface(iface.interfaceNumber);
      state.device = d; state.endpoint = iface.alternate.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk').endpointNumber;
      state.name = d.productName;
    },
    async write(state, bytes) { for (let i = 0; i < bytes.length; i += 4096) await state.device.transferOut(state.endpoint, bytes.slice(i, i + 4096)); },
    async disconnect(state) { await state.device?.close(); },
  },
  WEB_BLUETOOTH: {
    supported: () => 'bluetooth' in navigator,
    async connect(state) {
      const d = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
      const server = await d.gatt.connect();
      let ch = null;
      for (const uuid of BLE_SERVICES) {
        try {
          const svc = await server.getPrimaryService(uuid);
          ch = (await svc.getCharacteristics()).find((c) => c.properties.write || c.properties.writeWithoutResponse);
          if (ch) break;
        } catch { /* try next */ }
      }
      if (!ch) throw new Error('No writable printer characteristic found');
      state.device = d; state.ch = ch; state.name = d.name;
      d.addEventListener('gattserverdisconnected', () => { state.connected = false; });
    },
    async write(state, bytes) {
      for (let i = 0; i < bytes.length; i += 180) {
        const chunk = bytes.slice(i, i + 180);
        if (state.ch.properties.writeWithoutResponse) await state.ch.writeValueWithoutResponse(chunk); else await state.ch.writeValue(chunk);
      }
    },
    async disconnect(state) { state.device?.gatt?.disconnect(); },
  },
  WEB_SERIAL: {
    supported: () => 'serial' in navigator,
    async connect(state, cfg) {
      const p = await navigator.serial.requestPort();
      await p.open({ baudRate: Number(cfg.config?.baudRate || 9600) });
      state.port = p; state.name = 'Serial printer';
    },
    async write(state, bytes) { const w = state.port.writable.getWriter(); try { await w.write(bytes); } finally { w.releaseLock(); } },
    async disconnect(state) { await state.port?.close(); },
  },
  LAN: {
    supported: () => true,
    async connect(state, cfg) {
      const r = await fetch(`${BRIDGE}/status`, { signal: AbortSignal.timeout(2500) }).catch(() => null);
      if (!r?.ok) throw new Error('Local Print Bridge is not running on this computer (see bridge/README)');
      state.name = cfg.address;
    },
    async write(state, bytes, cfg) {
      const b64 = btoa(String.fromCharCode(...bytes));
      const r = await fetch(`${BRIDGE}/print`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: cfg.address, data: b64 }), signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Bridge print failed');
    },
    async disconnect() {},
  },
};
transports.BRIDGE = transports.LAN;

const state = {}; // printerId -> transport state

export const PrinterManager = {
  supported(conn) { return conn === 'BROWSER' || !!transports[conn]?.supported(); },
  isConnected(id) { return !!state[id]?.connected; },
  async connect(cfg) {
    if (cfg.connection === 'BROWSER') return report(cfg, 'CONNECTED');
    const t = transports[cfg.connection];
    if (!t?.supported()) throw new Error(`${cfg.connection} is not supported by this browser`);
    const s = state[cfg.id] || (state[cfg.id] = {});
    try { await t.connect(s, cfg); s.connected = true; await report(cfg, 'CONNECTED'); return s.name; } catch (e) { s.connected = false; await report(cfg, 'ERROR', e.message); throw e; }
  },
  async disconnect(cfg) {
    const t = transports[cfg.connection];
    if (t && state[cfg.id]) await t.disconnect(state[cfg.id]).catch(() => {});
    if (state[cfg.id]) state[cfg.id].connected = false;
    await report(cfg, 'DISCONNECTED');
  },
  async reconnect(cfg) { await this.disconnect(cfg); return this.connect(cfg); },
  async sendRaw(cfg, bytes) {
    const t = transports[cfg.connection];
    const s = state[cfg.id];
    if (!s?.connected) await this.connect(cfg);
    try { await t.write(state[cfg.id], bytes, cfg); } catch (e) { state[cfg.id].connected = false; await report(cfg, 'ERROR', e.message); throw new Error(`PRINTER OFFLINE: ${e.message}`); }
  },
  async printReceipt(cfg, receiptData, opts = {}) {
    if (!cfg || cfg.connection === 'BROWSER' || cfg.protocol === 'BROWSER') return browserPrint(opts.elementId || 'receipt-print');
    const bytes = receiptToEscPos(receiptData, { width: Number(cfg.paper_width) || 80, cutMode: cfg.cut_mode, feedLines: cfg.feed_lines, ...opts });
    const copies = Math.max(1, Number(opts.copies || 1));
    for (let i = 0; i < copies; i++) await this.sendRaw(cfg, bytes);
    if (cfg.cash_drawer && opts.openDrawer) await this.openDrawer(cfg);
  },
  async testPrint(cfg) {
    if (cfg.connection === 'BROWSER') return browserPrint('receipt-print');
    const p = new EscPos({ width: Number(cfg.paper_width) || 80 });
    p.align('center').bold().size(2, 2).line('TEST PRINT').size(1, 1).bold(false).line(cfg.name).line(new Date().toLocaleString('en-GB'))
      .hr().align('left').pair('ภาษาไทย', 'ทดสอบการพิมพ์').pair('Paper', `${cfg.paper_width}mm`).pair('Connection', cfg.connection).hr().align('center').qr('SMARTCARD-TEST', 5).feed(cfg.feed_lines || 3).cut(cfg.cut_mode);
    await this.sendRaw(cfg, p.build());
  },
  async openDrawer(cfg) {
    if (!cfg.cash_drawer) throw new Error('Cash drawer is not enabled for this printer');
    await this.sendRaw(cfg, new EscPos().drawer().build());
  },
  async bridgeScan(subnet) {
    const r = await fetch(`${BRIDGE}/scan?subnet=${encodeURIComponent(subnet)}`, { signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (!r?.ok) throw new Error('Local Print Bridge is not running on this computer');
    return r.json();
  },
};

async function report(cfg, status, message) {
  if (!cfg.id) return;
  try { await api.post(`/printers/${cfg.id}/status`, { status, message }); } catch { /* status reporting is best-effort */ }
}

/** Print a DOM element (receipt / A4 / labels) via the browser print dialog. */
export function browserPrint(elementId) {
  return new Promise((resolve) => {
    const el = document.getElementById(elementId);
    if (el) el.classList.add('print-area');
    const done = () => { el?.classList.remove('print-area'); window.removeEventListener('afterprint', done); resolve(); };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 50);
  });
}

export async function getDefaultPrinter(purpose = 'RECEIPT') {
  const { items } = await api.get('/printers');
  const local = localStorage.getItem(`sc.printer.${purpose}`);
  return items.find((p) => p.id === local) || items.find((p) => p.is_default && p.purpose === purpose) || items.find((p) => p.purpose === purpose) || null;
}
