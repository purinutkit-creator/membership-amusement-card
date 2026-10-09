// Test harness: fresh schema in the TEST database, real app over HTTP, cookie-aware client.
import http from 'node:http';
import { pool, query, one, tx } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { syncReferenceData, createOwner } from '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { attachSocket } from '../src/socket.js';
import { hashSecret, randomToken, sha256 } from '../src/lib/crypto.js';
import { setGroup, invalidateSettings } from '../src/services/settings.js';
import { config } from '../src/config.js';

if (!config.isTest || !/_test/.test(config.databaseUrl)) throw new Error('Tests must run with NODE_ENV=test against a *_test database');

export async function resetDb() {
  await query('DROP SCHEMA IF EXISTS public CASCADE');
  await query('CREATE SCHEMA public');
  await migrate();
  await syncReferenceData();
  invalidateSettings();
}

export class Client {
  constructor(base) { this.base = base; this.cookies = {}; this.headers = {}; }
  async req(method, path, body, extraHeaders = {}) {
    const headers = { 'x-requested-with': 'smartcard', ...this.headers, ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(this.base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [kv] = c.split(';'); const [k, ...v] = kv.split('=');
      if (/Expires=Thu, 01 Jan 1970/.test(c)) delete this.cookies[k]; else this.cookies[k] = v.join('=');
    }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  put(p, b = {}) { return this.req('PUT', p, b); }
  del(p) { return this.req('DELETE', p); }
}

export async function startServer() {
  const app = createApp();
  const server = http.createServer(app);
  attachSocket(server);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return { server, base, close: () => new Promise((r) => server.close(r)) };
}

/** Standard fixtures: branch, owner, manager, cashier, tiers, packages, machine + terminal device. */
export async function fixtures() {
  await createOwner({ username: 'owner', password: 'owner-password-123', pin: '999999', employeeCode: 'OWNER', firstName: 'Owner' });
  return tx(async (db) => {
    const branch = await one(db, `INSERT INTO branches(code, name) VALUES ('MAIN','Main') RETURNING *`);
    await db.query('UPDATE staff SET branch_id = $1', [branch.id]);
    const role = async (c) => (await one(db, 'SELECT id FROM roles WHERE code = $1', [c])).id;
    await db.query(`INSERT INTO staff(employee_code, username, first_name, role_id, branch_id, password_hash, pin_hash) VALUES
      ('M001','manager','Mana',$1,$3,$4,$5), ('C001','cashier','Chai',$2,$3,$6,$7)`,
      [await role('MANAGER'), await role('CASHIER'), branch.id, await hashSecret('manager-password'), await hashSecret('111111'), await hashSecret('cashier-password'), await hashSecret('222222')]);
    const bronze = await one(db, `INSERT INTO member_tiers(code, name, rank, color) VALUES ('BRONZE','Bronze',0,'#B45309') RETURNING *`);
    const gold = await one(db, `INSERT INTO member_tiers(code, name, rank, color, qualification, benefits) VALUES ('GOLD','Gold',1,'#D4A017','{"mode":"ANY","minTopup":2000}','{"topupBonusPct":5,"stampMultiplier":2}') RETURNING *`);
    const p500 = await one(db, `INSERT INTO topup_packages(name, pay_amount, bonus_amount) VALUES ('500', 500, 0) RETURNING *`);
    const p1000 = await one(db, `INSERT INTO topup_packages(name, pay_amount, bonus_amount, point_bonus) VALUES ('1000+200', 1000, 200, 50) RETURNING *`);
    const token = randomToken(32);
    const device = await one(db, `INSERT INTO devices(device_code, type, name, branch_id, token_hash) VALUES ('TERM-1','ARCADE_TERMINAL','T1',$1,$2) RETURNING *`, [branch.id, sha256(token)]);
    const machine = await one(db, `INSERT INTO machines(machine_code, name, branch_id, price, point_earn, stamp_earn, device_id) VALUES ('RC-01','Racer',$1,40,4,1,$2) RETURNING *`, [branch.id, device.id]);
    const machines = [machine];
    const tokens = [token];
    for (let i = 2; i <= 6; i++) {
      const t = randomToken(32);
      const d = await one(db, `INSERT INTO devices(device_code, type, name, branch_id, token_hash) VALUES ($1,'ARCADE_TERMINAL',$2,$3,$4) RETURNING *`, [`TERM-${i}`, `T${i}`, branch.id, sha256(t)]);
      machines.push(await one(db, `INSERT INTO machines(machine_code, name, branch_id, price, point_earn, stamp_earn, device_id) VALUES ($1,$2,$3,40,4,1,$4) RETURNING *`, [`RC-0${i}`, `Racer ${i}`, branch.id, d.id]));
      tokens.push(t);
    }
    await setGroup(db, 'promptpay', { idType: 'PHONE', phone: '0812345678', qrType: 'DYNAMIC' }, null);
    await setGroup(db, 'card', { deposit: 50, tapCooldownSec: 3 }, null);
    await setGroup(db, 'stamp', { conversion: { enabled: true, stamps: 10, points: 100, mode: 'STAFF' } }, null);
    invalidateSettings();
    return { branch, bronze, gold, p500, p1000, device, machine, machines, deviceToken: token, deviceTokens: tokens };
  });
}

export async function login(base, body) {
  const c = new Client(base);
  const r = await c.post('/auth/login', body);
  if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.data)}`);
  return c;
}

export function deviceClient(base, token) {
  const c = new Client(base);
  c.headers.authorization = `Device ${token}`;
  return c;
}

export const rid = () => `req-${randomToken(10)}`;
export { pool, query, one, tx };
