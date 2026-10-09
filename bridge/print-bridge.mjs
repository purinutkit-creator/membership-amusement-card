#!/usr/bin/env node
// Local Print Bridge — run on the POS computer to let the browser print ESC/POS to LAN /
// network printers (raw TCP 9100). Listens ONLY on 127.0.0.1.
//   node bridge/print-bridge.mjs            (port 9110, allowed origin from BRIDGE_ORIGIN or any localhost/LAN app)
// Endpoints: GET /status · POST /print {target:"192.168.1.50:9100", data:"<base64>"} · GET /scan?subnet=192.168.1
import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.env.BRIDGE_PORT || 9110);
const ORIGINS = (process.env.BRIDGE_ORIGIN || '').split(',').filter(Boolean);

function cors(req, res) {
  const o = req.headers.origin;
  if (o && (ORIGINS.length === 0 || ORIGINS.includes(o))) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

function sendRaw(target, buf) {
  const [host, port = '9100'] = String(target).replace(/^tcp:\/\//, '').split(':');
  if (!/^[0-9a-zA-Z.-]+$/.test(host)) return Promise.reject(new Error('Invalid printer address'));
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host, port: Number(port), timeout: 5000 }, () => s.end(buf, resolve));
    s.on('error', reject); s.on('timeout', () => { s.destroy(); reject(new Error('Printer timeout')); });
  });
}

function probe(host, port = 9100) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port, timeout: 400 }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false)); s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/status') return json(res, 200, { ok: true, version: '1.0.0' });
    if (url.pathname === '/print' && req.method === 'POST') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 5e6) throw new Error('Payload too large'); }
      const { target, data } = JSON.parse(body);
      await sendRaw(target, Buffer.from(data, 'base64'));
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/scan') {
      const subnet = url.searchParams.get('subnet') || '192.168.1';
      if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(subnet)) throw new Error('subnet must look like 192.168.1');
      const hosts = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);
      const found = [];
      for (let i = 0; i < hosts.length; i += 32) {
        const batch = hosts.slice(i, i + 32);
        const ok = await Promise.all(batch.map((h) => probe(h)));
        batch.forEach((h, j) => ok[j] && found.push(`${h}:9100`));
      }
      return json(res, 200, { printers: found });
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) { json(res, 500, { error: e.message }); }
}).listen(PORT, '127.0.0.1', () => console.log(`Print bridge listening on http://127.0.0.1:${PORT}`));
