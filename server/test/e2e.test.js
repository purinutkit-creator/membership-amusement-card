// End-to-end business scenarios 1–10 over the real HTTP API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, fixtures, login, deviceClient, Client, rid, pool, query, one } from './helpers.js';
import { mockGateway } from '../src/integrations/payment/mock.js';

let srv, fx, cashier, manager, owner, term;
const S = {}; // shared scenario state

before(async () => {
  await resetDb();
  fx = await fixtures();
  srv = await startServer();
  cashier = await login(srv.base, { employeeCode: 'C001', pin: '222222' });
  manager = await login(srv.base, { username: 'manager', password: 'manager-password' });
  owner = await login(srv.base, { username: 'owner', password: 'owner-password-123' });
  term = deviceClient(srv.base, fx.deviceToken);
  const r = await cashier.post('/shifts/open', { openingCash: 1000 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const cards = await owner.post('/cards', { count: 10, cardType: 'MEMBER' });
  assert.equal(cards.status, 201, JSON.stringify(cards.data));
  S.stock = cards.data.cards.map((c) => c.id);
});
after(async () => { await srv.close(); await pool.end(); });

test('Scenario 1: register member -> PIN -> issue 12-digit card -> top up ฿500 -> pay -> receipt -> display success', async () => {
  const m = await cashier.post('/members', { phone: '0891234567', firstName: 'Somchai', lastName: 'Jaidee', pin: '123456' });
  assert.equal(m.status, 201, JSON.stringify(m.data));
  assert.match(m.data.memberCode, /^MBR\d{6}$/);
  S.member = m.data;
  const dup = await cashier.post('/members', { phone: '089-123-4567', firstName: 'X', lastName: 'Y', pin: '123456' });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error.code, 'PHONE_EXISTS');

  const cardId = S.stock[0];
  const order = await cashier.post('/orders', { memberId: S.member.id, items: [{ type: 'CARD_ISSUE', cardId, memberId: S.member.id }, { type: 'TOPUP', cardId, packageId: fx.p500.id }] });
  assert.equal(order.status, 201, JSON.stringify(order.data));
  assert.equal(order.data.order.grand_total, 550); // 50 deposit + 500 top-up
  // balance must NOT be added before payment
  const before = await one({ query }, 'SELECT balance, status FROM cards WHERE id = $1', [cardId]);
  assert.equal(before.balance, 0);
  assert.equal(before.status, 'INACTIVE');

  const pay = await cashier.post(`/orders/${order.data.order.id}/pay`, { method: 'CASH', receivedAmount: 1000 });
  assert.equal(pay.status, 200, JSON.stringify(pay.data));
  assert.equal(pay.data.completed, true);
  assert.equal(pay.data.payment.change_amount, 450);
  const card = await cashier.get(`/cards/${cardId}`);
  assert.equal(card.data.balance, 500);
  assert.equal(card.data.status, 'ACTIVE');
  assert.match(card.data.cardNumber, /^[0-9]{12}$/);
  assert.equal(card.data.member.id, S.member.id);
  assert.equal(card.data.reconciliation.ok, true);
  S.card = card.data;

  const rc = await cashier.get(`/receipts/${pay.data.receipt.id}`);
  assert.equal(rc.status, 200);
  assert.match(rc.data.receipt_no, /^RCP\d{12}$/);
  assert.equal(rc.data.data.totals.grandTotal, 550);
  assert.equal(rc.data.data.cards[0].newBalance, 500);
  assert.equal(rc.data.data.payment.change, 450);
  const print = await cashier.post(`/receipts/${rc.data.id}/print`, {});
  assert.equal(print.status, 200);
  const reprint = await cashier.post(`/receipts/${rc.data.id}/print`, { reprint: true });
  assert.equal(reprint.status, 403, 'cashier has no reprint permission by default');

  // customer display pairing receives state from POS
  const pair = await cashier.post('/pairings');
  assert.equal(pair.status, 201);
  const disp = new Client(srv.base);
  const join = await disp.post('/pairings/join', { code: pair.data.code });
  assert.equal(join.status, 200);
  disp.headers.authorization = `Display ${join.data.token}`;
  const me = await disp.get('/display/me');
  assert.equal(me.status, 200);
  const push = await cashier.post(`/pairings/${pair.data.id}/state`, { screen: 'SUCCESS', balance: 500 });
  assert.equal(push.status, 200);
  const me2 = await disp.get('/display/me');
  assert.equal(me2.data.state.screen, 'SUCCESS');
});

test('Scenario 2: tap ฿40 arcade -> deduct -> balance ฿460 -> earn points/stamps', async () => {
  const r = await term.post('/tap', { machineId: fx.machine.id, cardIdentifier: S.card.cardNumber, requestId: rid(), timestamp: new Date().toISOString() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.result, 'APPROVED');
  assert.equal(r.data.amount, 40);
  assert.equal(r.data.balance, 460);
  assert.equal(r.data.pointsEarned, 4);
  assert.equal(r.data.stampsEarned, 1);
  const card = await cashier.get(`/cards/${S.card.id}`);
  assert.equal(card.data.balance, 460);
  assert.equal(card.data.totalPlay, 1);
});

test('Scenario 3: rapid duplicate tap is detected and not charged twice', async () => {
  const r = await term.post('/tap', { machineId: fx.machine.id, cardIdentifier: S.card.cardNumber, requestId: rid() });
  assert.equal(r.status, 409);
  assert.equal(r.data.result, 'DUPLICATE_TAP');
  const card = await cashier.get(`/cards/${S.card.id}`);
  assert.equal(card.data.balance, 460);
  // same requestId replayed (network retry) returns the original result, no new charge
  const id = rid();
  const a = await deviceClient(srv.base, fx.deviceTokens[1]).post('/tap', { machineId: fx.machines[1].id, cardIdentifier: S.card.cardNumber, requestId: id });
  const b = await deviceClient(srv.base, fx.deviceTokens[1]).post('/tap', { machineId: fx.machines[1].id, cardIdentifier: S.card.cardNumber, requestId: id });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(b.data.replayed, true);
  assert.equal(b.data.txnNo, a.data.txnNo);
  const after = await cashier.get(`/cards/${S.card.id}`);
  assert.equal(after.data.balance, 420);
});

test('Scenario 4: balance ฿20 vs ฿40 machine -> rejected, balance stays ฿20', async () => {
  const cardId = S.stock[1];
  const g = await cashier.post('/orders', { items: [{ type: 'CARD_ISSUE', cardId }, { type: 'TOPUP', cardId, amount: 20 }] });
  assert.equal(g.status, 201, JSON.stringify(g.data));
  await cashier.post(`/orders/${g.data.order.id}/pay`, { method: 'CASH', receivedAmount: 70 });
  const c = await cashier.get(`/cards/${cardId}`);
  assert.equal(c.data.balance, 20);
  assert.equal(c.data.cardType, 'GUEST');
  const r = await term.post('/tap', { machineId: fx.machine.id, cardIdentifier: c.data.cardNumber, requestId: rid() });
  assert.equal(r.status, 409);
  assert.equal(r.data.result, 'INSUFFICIENT_BALANCE');
  assert.equal(r.data.required, 40);
  assert.equal(r.data.balance, 20);
  assert.ok(r.data.topupUrl);
  const after = await cashier.get(`/cards/${cardId}`);
  assert.equal(after.data.balance, 20);
  S.guest = after.data;
});

test('Scenario 5: staff adds 5 stamps -> ledger -> member portal sees +5', async () => {
  const before = (await cashier.get(`/cards/${S.card.id}`)).data.stamps;
  const r = await cashier.post(`/cards/${S.card.id}/stamps`, { delta: 5, reason: 'Event participation' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.card.stamps, before + 5);
  const portal = new Client(srv.base);
  const li = await portal.post('/member/login', { phone: '0891234567', pin: '123456' });
  assert.equal(li.status, 200, JSON.stringify(li.data));
  assert.equal(li.data.stamps, before + 5);
  const tl = await portal.get('/member/timeline?type=stamp');
  assert.ok(tl.data.items.some((t) => t.type === 'STAMP_ADD' && t.stamps_delta === 5));
  // cashier cannot remove stamps without approval
  const rm = await cashier.post(`/cards/${S.card.id}/stamps`, { delta: -1, reason: 'mistake' });
  assert.equal(rm.status, 403);
  S.portal = portal;
});

test('Scenario 6: member redeems reward with stamps -> stock & stamps checked -> confirm -> deducted once', async () => {
  const rw = await owner.post('/rewards', { name: 'Keychain', pointsRequired: 0, stampsRequired: 5, stock: 2, memberOnly: true });
  assert.equal(rw.status, 201, JSON.stringify(rw.data));
  const list = await S.portal.get(`/member/rewards?cardId=${S.card.id}`);
  const item = list.data.items.find((x) => x.id === rw.data.id);
  assert.equal(item.eligible, true);
  const red = await S.portal.post(`/member/rewards/${rw.data.id}/redeem`, { cardId: S.card.id });
  assert.equal(red.status, 201, JSON.stringify(red.data));
  const stampsBefore = (await cashier.get(`/cards/${S.card.id}`)).data.stamps;
  const conf = await cashier.post('/redemptions/confirm', { code: red.data.code });
  assert.equal(conf.status, 200, JSON.stringify(conf.data));
  assert.equal(conf.data.card.stamps, stampsBefore - 5);
  const again = await cashier.post('/redemptions/confirm', { code: red.data.code });
  assert.equal(again.status, 409);
  assert.equal(again.data.error.code, 'REDEMPTION_USED');
  const stock = await one({ query }, 'SELECT stock FROM rewards WHERE id = $1', [rw.data.id]);
  assert.equal(stock.stock, 1);
  // not enough stamps -> rejected at request
  const lacking = await S.portal.post(`/member/rewards/${rw.data.id}/redeem`, { cardId: S.card.id });
  assert.equal(lacking.status, 409);
});

test('Scenario 7: lost card -> block -> replace -> balance/points/stamps transferred -> old card unusable', async () => {
  const old = (await cashier.get(`/cards/${S.card.id}`)).data;
  const blk = await cashier.post(`/cards/${old.id}/lost`, { reason: 'Customer lost card' });
  assert.equal(blk.status, 403, 'cashier lacks card.block');
  const blk2 = await manager.post(`/cards/${old.id}/lost`, { reason: 'Customer lost card' });
  assert.equal(blk2.status, 200);
  const tapLost = await term.post('/tap', { machineId: fx.machines[2].id, cardIdentifier: old.cardNumber, requestId: rid() });
  assert.equal(tapLost.status, 403, 'terminal 1 cannot drive machine 3');
  const tapLost2 = await deviceClient(srv.base, fx.deviceTokens[2]).post('/tap', { machineId: fx.machines[2].id, cardIdentifier: old.cardNumber, requestId: rid() });
  assert.equal(tapLost2.data.result, 'CARD_LOST');
  const rep = await manager.post(`/cards/${old.id}/replace`, { newCardId: S.stock[2], reason: 'Lost card replacement' });
  assert.equal(rep.status, 200, JSON.stringify(rep.data));
  assert.equal(rep.data.newCard.balance, old.balance);
  assert.equal(rep.data.newCard.points, old.points);
  assert.equal(rep.data.newCard.stamps, old.stamps);
  assert.equal(rep.data.newCard.member.id, S.member.id);
  assert.equal(rep.data.oldCard.status, 'REPLACED');
  const oldNow = (await cashier.get(`/cards/${old.id}`)).data;
  assert.equal(oldNow.balance, 0);
  assert.equal(oldNow.reconciliation.ok, true);
  const tapOld = await deviceClient(srv.base, fx.deviceTokens[3]).post('/tap', { machineId: fx.machines[3].id, cardIdentifier: old.cardNumber, requestId: rid() });
  assert.equal(tapOld.data.result, 'CARD_REPLACED');
  const tapNew = await deviceClient(srv.base, fx.deviceTokens[3]).post('/tap', { machineId: fx.machines[3].id, cardIdentifier: rep.data.newCard.cardNumber, requestId: rid() });
  assert.equal(tapNew.data.result, 'APPROVED');
  S.card = (await cashier.get(`/cards/${rep.data.newCard.id}`)).data;
});

test('Scenario 8: member portal top-up via gateway -> pending -> webhook confirms once (duplicate webhook ignored)', async () => {
  const pkgs = await S.portal.get('/member/packages');
  assert.equal(pkgs.status, 200);
  const before = S.card.balance;
  const t = await S.portal.post('/member/topup', { cardId: S.card.id, packageId: fx.p1000.id });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  assert.equal(t.data.status, 'PENDING');
  assert.ok(t.data.qrPayload);
  const mid = await S.portal.get(`/member/cards/${S.card.id}`);
  assert.equal(mid.data.balance, before, 'no balance before payment confirmed');
  const p = await one({ query }, 'SELECT * FROM payments WHERE id = $1', [t.data.paymentId]);
  const body = { eventId: 'evt_1', providerRef: p.provider_ref, paymentNo: p.payment_no, status: 'PAID', amount: 1000 };
  const raw = JSON.stringify(body);
  const bad = await fetch(`${srv.base}/public/payments/webhook/mock`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': 'nope' }, body: raw });
  assert.equal(bad.status, 401);
  const send = () => fetch(`${srv.base}/public/payments/webhook/mock`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': mockGateway.sign(raw) }, body: raw }).then((r) => r.json());
  const [a, b] = await Promise.all([send(), send()]);
  assert.ok(a.ok || b.ok);
  assert.ok(a.duplicate || b.duplicate);
  // a different event id for the same payment must also not double-credit
  const raw2 = JSON.stringify({ ...body, eventId: 'evt_2' });
  const c = await fetch(`${srv.base}/public/payments/webhook/mock`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': mockGateway.sign(raw2) }, body: raw2 }).then((r) => r.json());
  assert.equal(c.alreadyProcessed, true);
  const after = await S.portal.get(`/member/cards/${S.card.id}`);
  assert.equal(after.data.balance, before + 1200); // 1000 + 200 package bonus
  const topups = await one({ query }, `SELECT count(*)::int AS n FROM transactions WHERE type = 'TOP_UP' AND payment_id = $1`, [p.id]);
  assert.equal(topups.n, 1);
  S.card = (await cashier.get(`/cards/${S.card.id}`)).data;
});

test('Scenario 9: display member input -> phone -> member found -> tap card -> verify -> top up', async () => {
  const pair = await cashier.post('/pairings');
  const disp = new Client(srv.base);
  const join = await disp.post('/pairings/join', { code: pair.data.code });
  disp.headers.authorization = `Display ${join.data.token}`;
  const phone = await disp.post('/display/input', { type: 'PHONE', value: '0891234567' });
  assert.equal(phone.data.found, true);
  assert.equal(phone.data.memberId, S.member.id);
  const tap = await disp.post('/display/input', { type: 'CARD', value: S.card.cardNumber });
  assert.equal(tap.data.cardMemberId, S.member.id);
  // wrong card for this member is rejected
  const wrong = await cashier.post('/orders', { memberId: S.member.id, items: [{ type: 'TOPUP', cardId: S.guest.id, amount: 100 }] });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.data.error.code, 'CARD_MEMBER_MISMATCH');
  // member card without verified member is rejected (requireCardVerification)
  const unverified = await cashier.post('/orders', { items: [{ type: 'TOPUP', cardId: S.card.id, amount: 100 }] });
  assert.equal(unverified.status, 409);
  const ok = await cashier.post('/orders', { memberId: phone.data.memberId, items: [{ type: 'TOPUP', cardId: tap.data.cardId, amount: 100 }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const pp = await cashier.post(`/orders/${ok.data.order.id}/pay`, { method: 'PROMPTPAY' });
  assert.equal(pp.status, 200);
  assert.equal(pp.data.completed, false);
  assert.match(pp.data.payment.qr_payload, /^000201010212/);
  const mid = (await cashier.get(`/cards/${S.card.id}`)).data.balance;
  assert.equal(mid, S.card.balance, 'not credited until PromptPay is confirmed');
  const conf = await cashier.post(`/payments/${pp.data.payment.id}/confirm`, { reference: 'SLIP123' });
  assert.equal(conf.status, 200, JSON.stringify(conf.data));
  const conf2 = await cashier.post(`/payments/${pp.data.payment.id}/confirm`, {});
  assert.equal(conf2.data.alreadyProcessed, true);
  const after = (await cashier.get(`/cards/${S.card.id}`)).data.balance;
  assert.equal(after, S.card.balance + 100);
});

test('Scenario 10: owner traces revenue -> transaction -> payment -> staff -> member -> card', async () => {
  const rep = await owner.get('/reports/topup?range=today');
  assert.equal(rep.status, 200);
  assert.ok(rep.data.summary.paid >= 1600);
  const row = rep.data.rows.find((r) => r.card_number === S.card.cardNumber);
  assert.ok(row);
  const t = await owner.get(`/transactions/${row.txn_no}`);
  assert.equal(t.status, 200);
  assert.ok(t.data.payment_no);
  assert.ok(t.data.order_no || t.data.payment_method);
  assert.equal(t.data.card_number, S.card.cardNumber);
  assert.equal(t.data.member_code, S.member.memberCode);
  assert.ok(t.data.branch_name || t.data.staff_name);
  const liability = await owner.get('/reports/wallet-liability');
  assert.equal(liability.data.summary.reconciled, true);
  const dash = await owner.get('/dashboard');
  assert.equal(dash.status, 200);
  assert.ok(dash.data.kpi.topup >= 1600);
  assert.ok(dash.data.kpi.plays >= 3);
  const csv = await owner.req('GET', '/reports/sales?range=today&format=csv');
  assert.equal(csv.status, 200);
  assert.match(String(csv.data), /Order/);
  const audit = await owner.get('/audit-logs?action=TOP_UP');
  assert.ok(audit.data.total >= 1);
  // cashier cannot see the owner dashboard or export
  assert.equal((await cashier.get('/dashboard/owner')).status, 403);
  assert.equal((await cashier.req('GET', '/reports/sales?format=csv')).status, 403);
});

test('Refund creates reversal (never deletes) and requires approval for cashier', async () => {
  const cardId = S.stock[3];
  const o = await cashier.post('/orders', { items: [{ type: 'CARD_ISSUE', cardId }, { type: 'TOPUP', cardId, amount: 200 }] });
  await cashier.post(`/orders/${o.data.order.id}/pay`, { method: 'CASH' });
  const noPerm = await cashier.post(`/orders/${o.data.order.id}/refund`, { reason: 'Customer changed mind' });
  assert.equal(noPerm.status, 403);
  const ok = await manager.post(`/orders/${o.data.order.id}/refund`, { reason: 'Customer changed mind' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const txns = await query('SELECT type, reversal_of, reversed_by FROM transactions WHERE order_id = $1 ORDER BY created_at', [o.data.order.id]);
  assert.ok(txns.rows.some((t) => t.type === 'TOP_UP' && t.reversed_by));
  assert.ok(txns.rows.some((t) => t.type === 'REFUND' && t.reversal_of));
  const card = await one({ query }, 'SELECT balance, status FROM cards WHERE id = $1', [cardId]);
  assert.equal(card.balance, 0);
  const rc = await one({ query }, `SELECT * FROM receipts WHERE order_id = $1 AND type = 'REFUND'`, [o.data.order.id]);
  assert.ok(rc.original_receipt_id);
  const twice = await manager.post(`/orders/${o.data.order.id}/refund`, { reason: 'again please' });
  assert.equal(twice.status, 409);
  // play refund (machine malfunction) by manager
  const play = await one({ query }, `SELECT id FROM transactions WHERE type = 'PLAY' AND reversed_by IS NULL ORDER BY created_at DESC LIMIT 1`);
  const pr = await manager.post(`/transactions/${play.id}/refund`, { reason: 'Machine malfunction' });
  assert.equal(pr.status, 200, JSON.stringify(pr.data));
});

test('Shift close computes expected cash and over/short', async () => {
  const cur = await cashier.get('/shifts/current');
  // close pending payments first rule
  const pend = await one({ query }, `SELECT count(*)::int AS n FROM payments WHERE shift_id = $1 AND status = 'PENDING'`, [cur.data.shift.id]);
  assert.equal(pend.n, 0);
  await cashier.post('/shifts/cash', { type: 'CASH_OUT', amount: 100, reason: 'Petty cash for supplies' });
  const sum = await cashier.get('/shifts/current');
  const close = await cashier.post(`/shifts/${cur.data.shift.id}/close`, { actualCash: sum.data.cash.expected - 10 });
  assert.equal(close.status, 200, JSON.stringify(close.data));
  assert.equal(close.data.shift.over_short, -10);
});

test('Terminal tap works in a browser that also holds a staff session cookie (no CSRF false positive)', async () => {
  const c = deviceClient(srv.base, fx.deviceTokens[4] || fx.deviceTokens[1]);
  c.cookies = { ...cashier.cookies };
  const machine = fx.deviceTokens[4] ? fx.machines[4] : fx.machines[1];
  const r = await c.req('POST', '/tap', { machineId: machine.id, cardIdentifier: S.card.cardNumber, requestId: rid() }, { 'x-requested-with': '' });
  assert.notEqual(r.status, 403, JSON.stringify(r.data));
  assert.ok(['APPROVED', 'DUPLICATE_TAP', 'INSUFFICIENT_BALANCE'].includes(r.data.result), JSON.stringify(r.data));
  // a cookie-only state change without the header is still refused
  const bad = await cashier.req('POST', '/shifts/cash', { type: 'CASH_IN', amount: 1, reason: 'csrf probe' }, { 'x-requested-with': '' });
  assert.equal(bad.status, 403);
});
