// =====================================================================
// Card Reader Integration Layer
// Every reader implements: { type, label, supported(), connect(), disconnect(), status }
// and emits reads through ReaderManager.onRead(cb). Status is always truthful: a reader is only
// "connected" after the browser API actually opened the device.
//
//  KEYBOARD  — USB / RFID / barcode readers in keyboard-emulation (HID keyboard) mode. Works
//              immediately with no setup: fast keystrokes ending in Enter are captured.
//  WEB_NFC   — Android Chrome NFC (NDEFReader); returns the tag serial number (UID).
//  SERIAL    — Web Serial (USB-serial / RS-232 readers that print a line per card).
//  HID       — WebHID raw reports (vendor readers); bytes decoded as ASCII or hex UID.
//  BLE       — Bluetooth LE readers exposing a UART service (Nordic NUS) with notify.
// =====================================================================
import { useEffect, useRef } from 'react';

const listeners = new Set();
const statusListeners = new Set();
let lastRead = null;

function emitRead(value, source) {
  const v = String(value || '').trim();
  if (!v) return;
  lastRead = { value: v, source, at: new Date() };
  for (const l of listeners) l(v, source);
}
function emitStatus() { for (const l of statusListeners) l(ReaderManager.status()); }

class KeyboardReader {
  type = 'KEYBOARD'; label = 'Keyboard emulation (USB / RFID / barcode)'; status = 'CONNECTED';
  supported() { return true; }
  async connect() { this.status = 'CONNECTED'; }
  async disconnect() {}
}

class WebNfcReader {
  type = 'WEB_NFC'; label = 'NFC (Web NFC — Android Chrome)'; status = 'DISCONNECTED'; ctrl = null;
  supported() { return 'NDEFReader' in window; }
  async connect() {
    if (!this.supported()) throw new Error('Web NFC is not supported on this browser/device');
    this.ctrl = new AbortController();
    const r = new window.NDEFReader();
    await r.scan({ signal: this.ctrl.signal });
    r.onreading = (e) => emitRead(String(e.serialNumber || '').replace(/:/g, '').toUpperCase(), this.type);
    r.onreadingerror = () => {};
    this.status = 'CONNECTED';
  }
  async disconnect() { this.ctrl?.abort(); this.status = 'DISCONNECTED'; }
}

class SerialReader {
  type = 'SERIAL'; label = 'Serial / USB-Serial (Web Serial)'; status = 'DISCONNECTED'; port = null; reading = false;
  supported() { return 'serial' in navigator; }
  async connect(opts = {}) {
    if (!this.supported()) throw new Error('Web Serial is not supported (use Chrome / Edge desktop)');
    const ports = await navigator.serial.getPorts();
    this.port = opts.reuse && ports[0] ? ports[0] : await navigator.serial.requestPort();
    await this.port.open({ baudRate: Number(opts.baudRate || 9600) });
    this.status = 'CONNECTED';
    this.reading = true;
    this.loop();
  }
  async loop() {
    const decoder = new TextDecoder();
    let buf = '';
    while (this.port?.readable && this.reading) {
      const reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let i;
          while ((i = buf.search(/[\r\n]/)) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) emitRead(line.trim(), this.type); }
        }
      } catch { this.status = 'ERROR'; emitStatus(); } finally { reader.releaseLock(); }
    }
  }
  async disconnect() { this.reading = false; try { await this.port?.close(); } catch { /* */ } this.status = 'DISCONNECTED'; }
}

class HidReader {
  type = 'HID'; label = 'HID device (WebHID)'; status = 'DISCONNECTED'; device = null;
  supported() { return 'hid' in navigator; }
  async connect() {
    if (!this.supported()) throw new Error('WebHID is not supported (use Chrome / Edge desktop)');
    const [d] = await navigator.hid.requestDevice({ filters: [] });
    if (!d) throw new Error('No device selected');
    this.device = d;
    if (!d.opened) await d.open();
    d.oninputreport = (e) => {
      const bytes = new Uint8Array(e.data.buffer).filter((b) => b !== 0);
      if (!bytes.length) return;
      const ascii = String.fromCharCode(...bytes);
      emitRead(/^[\x20-\x7e]+$/.test(ascii) ? ascii : [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase(), this.type);
    };
    this.status = 'CONNECTED';
  }
  async disconnect() { try { await this.device?.close(); } catch { /* */ } this.status = 'DISCONNECTED'; }
}

const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
class BleReader {
  type = 'BLE'; label = 'Bluetooth LE reader (UART service)'; status = 'DISCONNECTED'; device = null;
  supported() { return 'bluetooth' in navigator; }
  async connect() {
    if (!this.supported()) throw new Error('Web Bluetooth is not supported on this browser');
    this.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [NUS_SERVICE] });
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(NUS_SERVICE);
    const ch = await svc.getCharacteristic(NUS_TX);
    await ch.startNotifications();
    const dec = new TextDecoder();
    ch.addEventListener('characteristicvaluechanged', (e) => emitRead(dec.decode(e.target.value).trim(), this.type));
    this.device.addEventListener('gattserverdisconnected', () => { this.status = 'DISCONNECTED'; emitStatus(); if (ReaderManager.autoReconnect) setTimeout(() => this.reconnect(), 2000); });
    this.status = 'CONNECTED';
  }
  async reconnect() { try { await this.device?.gatt.connect(); this.status = 'CONNECTED'; emitStatus(); } catch { /* retry on next disconnect */ } }
  async disconnect() { this.device?.gatt?.disconnect(); this.status = 'DISCONNECTED'; }
}

const readers = { KEYBOARD: new KeyboardReader(), WEB_NFC: new WebNfcReader(), SERIAL: new SerialReader(), HID: new HidReader(), BLE: new BleReader() };

export const ReaderManager = {
  autoReconnect: localStorage.getItem('sc.reader.auto') !== '0',
  readers,
  active: localStorage.getItem('sc.reader') || 'KEYBOARD',
  async connect(type, opts) {
    const r = readers[type];
    if (!r) throw new Error('Unknown reader');
    if (this.active !== type && this.active !== 'KEYBOARD') await readers[this.active].disconnect();
    await r.connect(opts);
    this.active = type;
    localStorage.setItem('sc.reader', type);
    emitStatus();
  },
  async disconnect() { await readers[this.active].disconnect(); this.active = 'KEYBOARD'; localStorage.setItem('sc.reader', 'KEYBOARD'); emitStatus(); },
  status() { const r = readers[this.active]; return { type: this.active, label: r.label, status: r.status, lastRead }; },
  onRead(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  onStatus(cb) { statusListeners.add(cb); return () => statusListeners.delete(cb); },
  /** Re-open a previously granted serial port without a picker (auto reconnect). */
  async restore() {
    if (this.active === 'SERIAL' && this.autoReconnect && 'serial' in navigator) {
      try { if ((await navigator.serial.getPorts()).length) await readers.SERIAL.connect({ reuse: true }); } catch { /* user must reconnect */ }
    }
    emitStatus();
  },
  simulate(value) { emitRead(value, 'SIMULATED'); },
};

/**
 * Keyboard-wedge capture: scanners "type" very fast and end with Enter.
 * When `whenFocused` is false, keystrokes into normal text inputs are ignored so typing still works.
 */
export function useKeyboardWedge(onScan, { enabled = true, minLength = 4, maxGapMs = 60, whenFocused = false } = {}) {
  const ref = useRef(onScan);
  ref.current = onScan;
  useEffect(() => {
    if (!enabled) return undefined;
    let buf = ''; let last = 0;
    const onKey = (e) => {
      const el = document.activeElement;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (typing && !whenFocused) return;
      const now = performance.now();
      if (now - last > maxGapMs) buf = '';
      last = now;
      if (e.key === 'Enter') {
        if (buf.length >= minLength) { e.preventDefault(); const v = buf; buf = ''; emitRead(v, 'KEYBOARD'); ref.current?.(v); }
        buf = '';
        return;
      }
      if (e.key.length === 1) buf += e.key;
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled, minLength, maxGapMs, whenFocused]);
}

/** Subscribe to reads from the non-keyboard readers (NFC / serial / HID / BLE / simulated). */
export function useCardReads(onRead, enabled = true) {
  const ref = useRef(onRead);
  ref.current = onRead;
  useEffect(() => {
    if (!enabled) return undefined;
    return ReaderManager.onRead((v, src) => { if (src !== 'KEYBOARD') ref.current?.(v, src); });
  }, [enabled]);
}
