// Critical invariants: ledger immutability, wallet guard, card numbers, concurrency, permissions,
// promotions, tiers, points/stamps, PromptPay QR.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, fixtures, login, deviceClient, rid, pool, query, one, tx } from './helpers.js';
import { isValidCardNumber, generateCardNumber } from '../src/lib/ids.js';
import { promptPayPayload, crc16 } from '../src/lib/promptpay.js';
import { evaluatePromotions, applyPriceEffects, rewardEffects } from '../src/services/promotions.js';
import { qualifies } from '../src/services/tiers.js';
import { machineBasePrice } from '../src/services/tap.js';
import { inTimeWindow } from '../src/lib/time.js';

let srv, fx, owner, cashier, manager;

async function activeCard(amount, { memberPhone } = {}) {
  const stock = await owner.post('/cards', { count: 1 });
  const cardId = stock.data.cards[0].id;
  let memberId = null;
  if (memberPhone) memberId = (await cashier.post('/members', { phone: memberPhone, firstName: 'T', lastName: 'Member', pin: '123456' })).data.id;
  const o = await cashier.post('/orders', { memberId, items: [{ type: 'CARD_ISSUE', cardId, memberId }, ...(amount ? [{ type: 'TOPUP', cardId, amount }] : [])] });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  const p = await cashier.post(`/orders/${o.data.order.id}/pay`, { method: 'CASH' });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  return (await cashier.get(`/cards/${cardId}`)).data;
}

before(async () => {
  await resetDb();
  fx = await fixtures();
  srv = await startServer();
  owner = await login(srv.base, { username: 'owner', password: 'owner-password-123' });
  cashier = await login(srv.base, { employeeCode: 'C001', pin: '222222' });
  manager = await login(srv.base, { employeeCode: 'M001', pin: '111111' });
  await cashier.post('/shifts/open', { openingCash: 0 });
});
after(async () => { await srv.close(); await pool.end(); });

// ---------------------------------------------------------------- card numbers
test('card numbers: exactly 12 digits, unique, collision-safe generation', async () => {
  assert.equal(isValidCardNumber('123456789012'), true);
  assert.equal(isValidCardNumber('12345678901'), false);
  assert.equal(isValidCardNumber('12345678901a'), false);
  const set = new Set(Array.from({ length: 2000 }, () => generateCardNumber('88')));
  for (const n of set) assert.match(n, /^88[0-9]{10}$/);
  const r = await owner.post('/cards', { numbers: ['123456789012'] });
  assert.equal(r.status, 201);
  const dup = await owner.post('/cards', { numbers: ['123456789012'] });
  assert.equal(dup.status, 409);
  const bad = await owner.post('/cards', { numbers: ['12345'] });
  assert.equal(bad.status, 422);
  const batch = await owner.post('/cards', { count: 500 });
  assert.equal(batch.data.count, 500);
  const n = await one({ query }, 'SELECT count(DISTINCT card_number)::int AS d, count(*)::int AS t FROM cards');
  assert.equal(n.d, n.t);
  await assert.rejects(query(`INSERT INTO cards(card_number) VALUES ('123456789012')`), /duplicate key/);
  await assert.rejects(query(`INSERT INTO cards(card_number) VALUES ('1234')`), /check constraint|value too long|violates/);
});

test('card identification: number, barcode text, QR portal URL/token, RFID uid', async () => {
  const c = await activeCard(100);
  await owner.post(`/cards/${c.id}/rfid`, { uid: '04a1b2c3d4' });
  for (const ident of [c.cardNumber, `${c.cardNumber.slice(0, 4)}-${c.cardNumber.slice(4, 8)}-${c.cardNumber.slice(8)}`, c.portalUrl, c.portalUrl.split('/c/')[1], '04A1B2C3D4']) {
    const r = await cashier.get(`/cards/lookup?identifier=${encodeURIComponent(ident)}`);
    assert.equal(r.status, 200, `identifier ${ident}`);
    assert.equal(r.data.id, c.id);
  }
  const nf = await cashier.get('/cards/lookup?identifier=999999999999');
  assert.equal(nf.status, 404);
  assert.equal(nf.data.error.code, 'CARD_NOT_FOUND');
});

// ---------------------------------------------------------------- DB-level financial guards
test('wallet values cannot be changed outside the ledger (DB trigger)', async () => {
  const c = await activeCard(50);
  await assert.rejects(query('UPDATE cards SET balance = 9999 WHERE id = $1', [c.id]), /WALLET_DIRECT_WRITE_FORBIDDEN/);
  await assert.rejects(query('UPDATE cards SET points = 9999 WHERE id = $1', [c.id]), /WALLET_DIRECT_WRITE_FORBIDDEN/);
  await assert.rejects(query(`INSERT INTO cards(card_number, balance) VALUES ('555555555555', 10)`), /WALLET_DIRECT_WRITE_FORBIDDEN/);
});

test('completed transactions cannot be deleted or edited (DB trigger)', async () => {
  const t = await one({ query }, 'SELECT id FROM transactions LIMIT 1');
  await assert.rejects(query('DELETE FROM transactions WHERE id = $1', [t.id]), /LEDGER_IMMUTABLE/);
  await assert.rejects(query('UPDATE transactions SET amount = 1 WHERE id = $1', [t.id]), /LEDGER_IMMUTABLE/);
  await assert.rejects(query('DELETE FROM audit_logs WHERE true'), /AUDIT_IMMUTABLE/);
});

test('balance never negative: ledger CHECK and card CHECK', async () => {
  const c = await activeCard(30);
  await assert.rejects(tx(async (db) => {
    await db.query(`SELECT set_config('app.ledger_write','on',true)`);
    await db.query('UPDATE cards SET balance = -1 WHERE id = $1', [c.id]);
  }), /check/i);
});

// ---------------------------------------------------------------- concurrency
test('concurrent taps on many machines cannot overdraw a card (row lock)', async () => {
  const c = await activeCard(100); // enough for exactly 2 plays at ฿40
  const reqs = fx.machines.map((m, i) => deviceClient(srv.base, fx.deviceTokens[i]).post('/tap', { machineId: m.id, cardIdentifier: c.cardNumber, requestId: rid() }));
  const res = await Promise.all(reqs);
  const approved = res.filter((r) => r.status === 200);
  const rejected = res.filter((r) => r.data.result === 'INSUFFICIENT_BALANCE');
  assert.equal(approved.length, 2, JSON.stringify(res.map((r) => r.data.result)));
  assert.equal(rejected.length, fx.machines.length - 2);
  const after = (await cashier.get(`/cards/${c.id}`)).data;
  assert.equal(after.balance, 20);
  assert.equal(after.reconciliation.ok, true);
});

test('concurrent identical requestId charges once', async () => {
  const c = await activeCard(200);
  const id = rid();
  const term = deviceClient(srv.base, fx.deviceToken);
  const res = await Promise.all(Array.from({ length: 5 }, () => term.post('/tap', { machineId: fx.machine.id, cardIdentifier: c.cardNumber, requestId: id })));
  const txnNos = new Set(res.filter((r) => r.data.txnNo).map((r) => r.data.txnNo));
  assert.equal(txnNos.size, 1);
  const after = (await cashier.get(`/cards/${c.id}`)).data;
  assert.equal(after.balance, 160);
});

test('concurrent confirmations of one PromptPay payment credit once', async () => {
  const c = await activeCard(20);
  const o = await cashier.post('/orders', { items: [{ type: 'TOPUP', cardId: c.id, amount: 300 }] });
  const p = await cashier.post(`/orders/${o.data.order.id}/pay`, { method: 'PROMPTPAY' });
  const res = await Promise.all(Array.from({ length: 4 }, () => cashier.post(`/payments/${p.data.payment.id}/confirm`, {})));
  assert.ok(res.every((r) => r.status === 200), JSON.stringify(res.map((r) => r.data)));
  assert.equal(res.filter((r) => !r.data.alreadyProcessed).length, 1);
  assert.equal((await cashier.get(`/cards/${c.id}`)).data.balance, 320);
});

// ---------------------------------------------------------------- tap rules
test('tap: blocked / expired / maintenance / unknown device are rejected without charge', async () => {
  const c = await activeCard(100);
  const term = deviceClient(srv.base, fx.deviceToken);
  await manager.post(`/cards/${c.id}/block`, { reason: 'Suspicious usage' });
  assert.equal((await term.post('/tap', { machineId: fx.machine.id, cardIdentifier: c.cardNumber, requestId: rid() })).data.result, 'CARD_BLOCKED');
  await manager.post(`/cards/${c.id}/unblock`, {});
  await owner.post(`/machines/${fx.machine.id}/status`, { status: 'MAINTENANCE' });
  assert.equal((await term.post('/tap', { machineId: fx.machine.id, cardIdentifier: c.cardNumber, requestId: rid() })).data.result, 'MACHINE_UNAVAILABLE');
  await owner.post(`/machines/${fx.machine.id}/status`, { status: 'AVAILABLE' });
  const unknown = deviceClient(srv.base, 'not-a-real-token');
  assert.equal((await unknown.post('/tap', { machineId: fx.machine.id, cardIdentifier: c.cardNumber, requestId: rid() })).status, 401);
  // expired
  await tx(async (db) => { await db.query(`UPDATE cards SET expires_at = now() - interval '1 day' WHERE id = $1`, [c.id]); });
  assert.equal((await term.post('/tap', { machineId: fx.machine.id, cardIdentifier: c.cardNumber, requestId: rid() })).data.result, 'CARD_EXPIRED');
  assert.equal((await cashier.get(`/cards/${c.id}`)).data.balance, 100);
});

test('machine pricing: member, tier, happy hour, free play', () => {
  const m = { price: 40, member_price: 35, tier_prices: { gold: 30 }, free_play: false, happy_hour: { enabled: true, days: [], start: '00:00', end: '23:59', price: 25 } };
  assert.equal(machineBasePrice({ ...m, happy_hour: { enabled: false } }, {}).price, 40);
  assert.equal(machineBasePrice({ ...m, happy_hour: { enabled: false } }, { memberId: 'x' }).price, 35);
  assert.equal(machineBasePrice({ ...m, happy_hour: { enabled: false } }, { memberId: 'x', tierId: 'gold' }).price, 30);
  assert.equal(machineBasePrice(m, {}).price, 25);
  assert.equal(machineBasePrice({ ...m, free_play: true }, {}).price, 0);
  assert.equal(inTimeWindow(23 * 60 + 30, '22:00', '02:00'), true);
  assert.equal(inTimeWindow(3 * 60, '22:00', '02:00'), false);
});

// ---------------------------------------------------------------- promotions & tiers & loyalty
test('promotion engine: rules, price effects, priority vs best vs stackable', async () => {
  assert.deepEqual(applyPriceEffects(40, [{ id: 'a', name: 'a', effect_type: 'DISCOUNT_PERCENT', effect_value: 25 }]).price, 30);
  assert.equal(applyPriceEffects(40, [{ id: 'a', name: 'a', effect_type: 'FREE_PLAY', effect_value: 0 }]).price, 0);
  assert.equal(applyPriceEffects(40, [{ id: 'a', name: 'a', effect_type: 'DISCOUNT_AMOUNT', effect_value: 100 }]).price, 0);
  const fx2 = rewardEffects(500, [{ id: 'b', name: 'b', effect_type: 'BONUS_PERCENT', effect_value: 10, max_benefit: 30 }, { id: 'c', name: 'c', effect_type: 'POINT_BONUS', effect_value: 5 }]);
  assert.equal(fx2.bonus, 30);
  assert.equal(fx2.pointBonus, 5);

  const mk = (b) => owner.post('/promotions', { appliesTo: 'TOP_UP', status: 'ACTIVE', ...b });
  await mk({ name: 'Small', effectType: 'BONUS_AMOUNT', effectValue: 20, priority: 1, rules: [{ type: 'MIN_AMOUNT', value: 100 }] });
  await mk({ name: 'Big', effectType: 'BONUS_AMOUNT', effectValue: 50, priority: 5, rules: [{ type: 'MIN_AMOUNT', value: 100 }] });
  await mk({ name: 'Stack', effectType: 'BONUS_AMOUNT', effectValue: 5, stackable: true, rules: [{ type: 'MIN_AMOUNT', value: 100 }] });
  await mk({ name: 'Members', effectType: 'BONUS_AMOUNT', effectValue: 999, rules: [{ type: 'MEMBER_ONLY', value: true }] });
  const bad = await mk({ name: 'Bad', effectType: 'FREE_PLAY', effectValue: 0 });
  assert.equal(bad.status, 422);
  let r = await evaluatePromotions({ query }, { appliesTo: 'TOP_UP', amount: 200 });
  assert.deepEqual(r.applied.map((p) => p.name).sort(), ['Small', 'Stack']);
  r = await evaluatePromotions({ query }, { appliesTo: 'TOP_UP', amount: 50 });
  assert.equal(r.applied.length, 0);
  await owner.put('/settings/promotion', { value: { policy: 'BEST' } });
  r = await evaluatePromotions({ query }, { appliesTo: 'TOP_UP', amount: 200 });
  assert.deepEqual(r.applied.map((p) => p.name).sort(), ['Big', 'Stack']);
  await owner.put('/settings/promotion', { value: { policy: 'STACK' } });
  r = await evaluatePromotions({ query }, { appliesTo: 'TOP_UP', amount: 200 });
  assert.equal(r.applied.length, 3);
  // applied to a real top-up as bonus
  const c = await activeCard(0);
  const o = await cashier.post('/orders', { items: [{ type: 'TOPUP', cardId: c.id, amount: 200 }] });
  assert.equal(o.data.priced.lines[0].meta.bonus, 75);
  await cashier.post(`/orders/${o.data.order.id}/pay`, { method: 'CASH' });
  assert.equal((await cashier.get(`/cards/${c.id}`)).data.balance, 275);
  await owner.put('/settings/promotion', { value: { policy: 'PRIORITY' } });
  for (const p of (await owner.get('/promotions')).data.items) await owner.post(`/promotions/${p.id}/status`, { status: 'INACTIVE' });
});

test('tier qualification, auto-upgrade, tier top-up bonus and stamp multiplier', async () => {
  assert.equal(qualifies({ qualification: {} }, {}), true);
  assert.equal(qualifies({ qualification: { mode: 'ANY', minTopup: 2000 } }, { total_topup: 1999 }), false);
  assert.equal(qualifies({ qualification: { mode: 'ALL', minTopup: 100, minPlays: 2 } }, { total_topup: 200, total_play: 1 }), false);
  const c = await activeCard(1000, { memberPhone: '0800000001' });
  const m1 = await cashier.get(`/members/${c.member.id}`);
  assert.equal(m1.data.tier.code, 'BRONZE');
  const o = await cashier.post('/orders', { memberId: c.member.id, items: [{ type: 'TOPUP', cardId: c.id, packageId: fx.p1000.id }] });
  await cashier.post(`/orders/${o.data.order.id}/pay`, { method: 'CASH' });
  const m2 = await cashier.get(`/members/${c.member.id}`);
  assert.equal(m2.data.tier.code, 'GOLD', 'auto-upgraded at ฿2,000 total top-up');
  const notes = await query(`SELECT * FROM notifications WHERE member_id = $1 AND type = 'TIER_UPGRADE'`, [c.member.id]);
  assert.equal(notes.rowCount, 1);
  // now Gold: +5% top-up bonus
  const o2 = await cashier.post('/orders', { memberId: c.member.id, items: [{ type: 'TOPUP', cardId: c.id, amount: 100 }] });
  assert.equal(o2.data.priced.lines[0].meta.tierBonus, 5);
  // Gold x2 stamps on play
  const tap = await deviceClient(srv.base, fx.deviceTokens[4]).post('/tap', { machineId: fx.machines[4].id, cardIdentifier: c.cardNumber, requestId: rid() });
  assert.equal(tap.data.stampsEarned, 2);
  // manual tier change is locked & audited
  const man = await manager.put(`/members/${c.member.id}`, { tierId: fx.bronze.id });
  assert.equal(man.status, 200);
  assert.equal(man.data.tierLocked, true);
});

test('stamp -> point conversion and manual adjustments with audit', async () => {
  const c = await activeCard(20, { memberPhone: '0800000002' });
  await cashier.post(`/cards/${c.id}/stamps`, { delta: 23, reason: 'Promo event' });
  const conv = await cashier.post(`/cards/${c.id}/convert-stamps`, {});
  assert.equal(conv.status, 200, JSON.stringify(conv.data));
  assert.equal(conv.data.card.stamps, 3);
  assert.equal(conv.data.card.points, 200);
  const adj = await cashier.post(`/cards/${c.id}/adjust`, { delta: 5, reason: 'Goodwill' });
  assert.equal(adj.status, 403, 'cashier lacks card.adjust_balance');
  const need = await manager.post(`/cards/${c.id}/adjust`, { delta: -5, reason: 'Correction' });
  assert.equal(need.status, 200, 'manager self-approves');
  const log = await one({ query }, `SELECT * FROM audit_logs WHERE action = 'BALANCE_ADJUSTMENT' AND target_id = $1`, [c.id]);
  assert.equal(log.old_data.balance, 20);
  assert.equal(log.new_data.balance, 15);
  assert.equal(log.new_data.adjustment, -5);
});

// ---------------------------------------------------------------- permissions & auth
test('RBAC, manager approval, discount limits, staff permission overrides', async () => {
  // approval flow: grant cashier card.adjust_balance, but approval still required
  const cashierRow = await one({ query }, `SELECT id FROM staff WHERE employee_code = 'C001'`);
  await owner.put(`/staff/${cashierRow.id}/permissions`, { overrides: [{ code: 'card.adjust_balance', effect: 'GRANT' }] });
  const c = await activeCard(20);
  const r1 = await cashier.post(`/cards/${c.id}/adjust`, { delta: 1, reason: 'Small fix' });
  assert.equal(r1.status, 403);
  assert.equal(r1.data.error.code, 'APPROVAL_REQUIRED');
  const r2 = await cashier.post(`/cards/${c.id}/adjust`, { delta: 1, reason: 'Small fix', approval: { employeeCode: 'M001', pin: '000000' } });
  assert.equal(r2.data.error.code, 'INVALID_APPROVAL');
  const r3 = await cashier.post(`/cards/${c.id}/adjust`, { delta: 1, reason: 'Small fix', approval: { employeeCode: 'M001', pin: '111111' } });
  assert.equal(r3.status, 200, JSON.stringify(r3.data));
  const t = await one({ query }, `SELECT approver_id FROM transactions WHERE type = 'BALANCE_ADJUSTMENT' AND card_id = $1`, [c.id]);
  assert.ok(t.approver_id);
  await owner.put(`/staff/${cashierRow.id}/permissions`, { overrides: [{ code: 'member.view', effect: 'DENY' }] });
  assert.equal((await cashier.get('/members')).status, 403);
  await owner.put(`/staff/${cashierRow.id}/permissions`, { overrides: [] });

  // discount limit: cashier role max 10%
  const prod = await owner.post('/products', { name: 'Pad Thai', price: 100, kind: 'FOOD' });
  const ok = await cashier.post('/orders', { items: [{ type: 'PRODUCT', productId: prod.data.id, qty: 1 }], manualDiscount: { mode: 'PERCENT', value: 10 } });
  assert.equal(ok.status, 201);
  const over = await cashier.post('/orders', { items: [{ type: 'PRODUCT', productId: prod.data.id, qty: 1 }], manualDiscount: { mode: 'PERCENT', value: 25 } });
  assert.equal(over.status, 403);
  assert.equal(over.data.error.code, 'APPROVAL_REQUIRED');
  const appr = await cashier.post('/orders', { items: [{ type: 'PRODUCT', productId: prod.data.id, qty: 1 }], manualDiscount: { mode: 'PERCENT', value: 25 }, approval: { employeeCode: 'M001', pin: '111111' } });
  assert.equal(appr.status, 201, JSON.stringify(appr.data));
  assert.equal(appr.data.order.grand_total, 75);

  // owner protections
  const ownerRow = await one({ query }, 'SELECT id FROM staff WHERE is_owner');
  assert.equal((await manager.del(`/staff/${ownerRow.id}`)).status, 403);
  assert.equal((await owner.del(`/staff/${ownerRow.id}`)).status, 403);
});

test('login protection: lockout after repeated failures, CSRF header required, hashes stored', async () => {
  const { Client } = await import('./helpers.js');
  const c = new Client(srv.base);
  for (let i = 0; i < 5; i++) await c.post('/auth/login', { employeeCode: 'M001', pin: '000000' });
  const locked = await c.post('/auth/login', { employeeCode: 'M001', pin: '111111' });
  assert.equal(locked.status, 423);
  await owner.post(`/staff/${(await one({ query }, `SELECT id FROM staff WHERE employee_code = 'M001'`)).id}/reset-credentials`, { unlock: true });
  const s = await one({ query }, `SELECT pin_hash, password_hash FROM staff WHERE employee_code = 'M001'`);
  assert.match(s.pin_hash, /^scrypt\$/);
  assert.doesNotMatch(s.pin_hash, /111111/);
  const noCsrf = await fetch(`${srv.base}/members`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: Object.entries(cashier.cookies).map(([k, v]) => `${k}=${v}`).join('; ') }, body: '{}' });
  assert.equal(noCsrf.status, 403);
  const m = await one({ query }, `SELECT pin_hash FROM members LIMIT 1`);
  assert.match(m.pin_hash, /^scrypt\$/);
});

test('PromptPay EMVCo payload has valid CRC and amount', () => {
  const p = promptPayPayload({ idType: 'PHONE', id: '0812345678', amount: 500 });
  assert.match(p, /^000201010212/);
  assert.match(p, /29370016A00000067701011101130066812345678/);
  assert.match(p, /5406500\.00/);
  assert.equal(p.slice(-4), crc16(p.slice(0, -4)));
  const s = promptPayPayload({ idType: 'TAX_ID', id: '0105550000001' });
  assert.match(s, /^000201010211/);
  assert.doesNotMatch(s, /54\d\d/);
  assert.equal(crc16('123456789'), '29B1'); // CRC-16/CCITT-FALSE check value
  assert.throws(() => promptPayPayload({ idType: 'PHONE', id: '123' }));
});

test('reports compute from the ledger and reconcile with card balances', async () => {
  for (const key of (await owner.get('/reports')).data.items.map((x) => x.key)) {
    const r = await owner.get(`/reports/${key}?range=today`);
    assert.equal(r.status, 200, `${key}: ${JSON.stringify(r.data)}`);
  }
  const wl = await owner.get('/reports/wallet-liability');
  assert.equal(wl.data.summary.reconciled, true);
  const x = await owner.req('GET', '/reports/topup?range=today&format=xlsx');
  assert.equal(x.status, 200);
  const search = await cashier.get('/search?q=Pad');
  assert.equal(search.status, 200);
});
