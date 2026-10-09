// POS: orders, payments, shifts, receipts, transactions, packages, products, stock.
import { Router } from 'express';
import { tx, one, many, query } from '../db/pool.js';
import { parse, z, zReason, zMoney, zPosMoney, zOptUuid } from '../lib/validate.js';
import { fail } from '../lib/errors.js';
import { perm, permAny, requireStaff } from '../middleware/auth.js';
import { requireApproval } from '../services/auth.js';
import * as orders from '../services/orders.js';
import * as shifts from '../services/shifts.js';
import { moveStock } from '../services/rewards.js';
import { audit } from '../services/audit.js';
import { paginate, where, dateRange } from './_util.js';
import { getGateway } from '../integrations/payment/index.js';
import { sendEmail, emailConfigured } from '../integrations/email/index.js';
import { config } from '../config.js';
import { randomToken } from '../lib/crypto.js';
import { escapeHtml } from '../lib/html.js';

const r = Router();
r.use(requireStaff);

const itemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PRODUCT'), productId: z.string().uuid(), qty: z.number().int().min(1).max(999), discount: zMoney.optional() }),
  z.object({ type: z.literal('TOPUP'), cardId: z.string().uuid(), packageId: z.string().uuid().optional(), amount: zPosMoney.optional() }),
  z.object({ type: z.literal('CARD_ISSUE'), cardId: z.string().uuid(), memberId: zOptUuid, waiveDeposit: z.boolean().optional(), waiveReason: z.string().max(200).optional() }),
  z.object({ type: z.literal('CARD_REPLACEMENT'), oldCardId: z.string().uuid(), newCardId: z.string().uuid(), reason: z.string().max(300).optional() }),
]);
const orderSchema = z.object({
  items: z.array(itemSchema).min(1).max(100), memberId: zOptUuid, cardId: zOptUuid, merchantId: zOptUuid, note: z.string().max(500).optional(),
  manualDiscount: z.object({ mode: z.enum(['AMOUNT', 'PERCENT']), value: z.number().min(0) }).optional(),
  approval: z.object({ employeeCode: z.string(), pin: z.string() }).optional(),
});

function checkItemPerms(ctx, items) {
  for (const it of items) {
    if (it.type === 'TOPUP' && !ctx.staff.permissions.has('topup.create')) throw fail('FORBIDDEN', undefined, { permission: 'topup.create' });
    if (it.type === 'CARD_ISSUE' && !ctx.staff.permissions.has('card.issue')) throw fail('FORBIDDEN', undefined, { permission: 'card.issue' });
    if (it.type === 'CARD_ISSUE' && it.waiveDeposit && !it.waiveReason) throw fail('VALIDATION_ERROR', 'Reason required to waive deposit');
    if (it.type === 'CARD_REPLACEMENT' && !ctx.staff.permissions.has('card.replace')) throw fail('FORBIDDEN', undefined, { permission: 'card.replace' });
    if (it.type === 'PRODUCT' && it.discount > 0 && !ctx.staff.permissions.has('pos.discount')) throw fail('FORBIDDEN', 'Discount not permitted');
  }
}

// ---------------------------------------------------------------- orders
r.post('/orders/price', perm('pos.open'), async (req, res) => {
  const b = parse(orderSchema, req.body);
  res.json(await orders.priceOrder({ query }, req.ctx, b));
});

r.post('/orders', perm('pos.open'), async (req, res) => {
  const b = parse(orderSchema, req.body);
  checkItemPerms(req.ctx, b.items);
  const out = await orders.createOrder(req.ctx, { ...b, channel: 'POS' });
  res.status(201).json({ order: out.order, priced: out.priced });
});

r.get('/orders', permAny('pos.open', 'transaction.view'), async (req, res) => {
  const w = where();
  if (req.query.status) w.add('o.status = $?', req.query.status);
  if (req.query.branchId) w.add('o.branch_id = $?', req.query.branchId);
  if (req.query.staffId) w.add('o.staff_id = $?', req.query.staffId);
  if (req.query.shiftId) w.add('o.shift_id = $?', req.query.shiftId);
  if (req.query.merchantId) w.add('o.merchant_id = $?', req.query.merchantId);
  if (req.query.memberId) w.add('o.member_id = $?', req.query.memberId);
  if (req.query.q) w.add('(o.order_no ILIKE $? OR m.phone LIKE $?)', `%${req.query.q}%`, `%${req.query.q}%`);
  if (req.query.range || req.query.from) { const d = dateRange(req.query); w.add(`o.created_at >= ($?::timestamp AT TIME ZONE '${d.tz}')`, d.start).add(`o.created_at < ($?::timestamp AT TIME ZONE '${d.tz}')`, d.end); }
  res.json(await paginate(`SELECT o.*, s.first_name AS staff_name, m.first_name || ' ' || m.last_name AS member_name, m.member_code,
      (SELECT method FROM payments p WHERE p.order_id = o.id AND p.status IN ('PAID','REFUNDED') LIMIT 1) AS payment_method
    FROM orders o LEFT JOIN staff s ON s.id = o.staff_id LEFT JOIN members m ON m.id = o.member_id ${w.sql()}`, w.params, req.query, 'o.created_at DESC'));
});

r.get('/orders/:id', permAny('pos.open', 'transaction.view'), async (req, res) => {
  const o = await one({ query }, `SELECT o.*, s.first_name || ' ' || s.last_name AS staff_name, m.member_code, m.first_name || ' ' || m.last_name AS member_name, m.phone AS member_phone, b.name AS branch_name
    FROM orders o LEFT JOIN staff s ON s.id = o.staff_id LEFT JOIN members m ON m.id = o.member_id LEFT JOIN branches b ON b.id = o.branch_id WHERE o.id = $1`, [req.params.id]);
  if (!o) throw fail('NOT_FOUND');
  const [items, payments, receipts, txns, refunds] = await Promise.all([
    many({ query }, 'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [o.id]),
    many({ query }, 'SELECT p.*, s.first_name AS confirmed_by_name FROM payments p LEFT JOIN staff s ON s.id = p.confirmed_by WHERE order_id = $1 ORDER BY created_at', [o.id]),
    many({ query }, 'SELECT id, receipt_no, type, created_at, print_count, reprint_count FROM receipts WHERE order_id = $1 ORDER BY created_at', [o.id]),
    many({ query }, 'SELECT t.*, c.card_number FROM transactions t JOIN cards c ON c.id = t.card_id WHERE t.order_id = $1 ORDER BY t.created_at', [o.id]),
    many({ query }, 'SELECT r.*, s.first_name AS staff_name, a.first_name AS approver_name FROM refunds r LEFT JOIN staff s ON s.id = r.staff_id LEFT JOIN staff a ON a.id = r.approver_id WHERE order_id = $1', [o.id]),
  ]);
  res.json({ ...o, items, payments, receipts, transactions: txns, refunds });
});

r.post('/orders/:id/pay', perm('pos.open'), async (req, res) => {
  const b = parse(z.object({
    method: z.enum(['CASH', 'PROMPTPAY', 'BANK_TRANSFER', 'CREDIT_CARD', 'DEBIT_CARD', 'E_WALLET', 'GATEWAY', 'CARD_BALANCE', 'OTHER']),
    receivedAmount: zMoney.optional(), reference: z.string().max(60).optional(), cardIdentifier: z.string().max(300).optional(), idempotencyKey: z.string().max(80).optional(),
  }), req.body);
  if (b.idempotencyKey) {
    const prev = await one({ query }, 'SELECT * FROM payments WHERE idempotency_key = $1', [b.idempotencyKey]);
    if (prev) return res.json({ payment: prev, completed: prev.status === 'PAID', replayed: true });
  }
  const out = await orders.payOrder(req.ctx, req.params.id, b);
  res.json(out);
});

r.post('/orders/:id/void', perm('pos.open'), async (req, res) => {
  const b = parse(z.object({ reason: zReason, approval: z.any().optional() }), req.body);
  // A cashier may abandon their own unpaid cart within 30 minutes; anything else is a real void.
  const o = await one({ query }, 'SELECT staff_id, created_at, status FROM orders WHERE id = $1', [req.params.id]);
  const ownFresh = o && o.status === 'PENDING_PAYMENT' && o.staff_id === req.ctx.staff.id && Date.now() - new Date(o.created_at).getTime() < 30 * 60000;
  if (!ownFresh) {
    if (!req.ctx.staff.permissions.has('pos.void')) throw fail('FORBIDDEN', undefined, { permission: 'pos.void' });
    await requireApproval(req.ctx, 'pos.void', b.approval);
  }
  res.json(await orders.cancelOrder(req.ctx, req.params.id, b.reason));
});

r.post('/orders/:id/refund', perm('pos.refund'), async (req, res) => {
  const b = parse(z.object({ reason: zReason, approval: z.any().optional() }), req.body);
  const hasTopup = await one({ query }, `SELECT 1 FROM order_items WHERE order_id = $1 AND item_type = 'TOPUP'`, [req.params.id]);
  if (hasTopup && !req.ctx.staff.permissions.has('topup.refund')) throw fail('FORBIDDEN', undefined, { permission: 'topup.refund' });
  const approverId = await requireApproval(req.ctx, hasTopup ? 'topup.refund' : 'pos.refund', b.approval);
  const out = await orders.refundOrder(req.ctx, req.params.id, { reason: b.reason, approverId });
  res.json({ refundNo: out.refund.refund_no, receiptId: out.receipt.id, reversals: out.reversals.map((t) => t.txn_no) });
});

// ---------------------------------------------------------------- payments
r.get('/payments/:id', permAny('pos.open', 'transaction.view'), async (req, res) => {
  const p = await one({ query }, 'SELECT * FROM payments WHERE id = $1', [req.params.id]);
  if (!p) throw fail('NOT_FOUND');
  res.json(p);
});

r.post('/payments/:id/confirm', perm('payment.confirm'), async (req, res) => {
  const b = parse(z.object({ reference: z.string().max(80).optional() }), req.body);
  const p = await one({ query }, 'SELECT * FROM payments WHERE id = $1', [req.params.id]);
  if (!p) throw fail('NOT_FOUND');
  if (!['PROMPTPAY', 'BANK_TRANSFER'].includes(p.method)) throw fail('CONFLICT', 'Only PromptPay / bank transfer can be confirmed manually — gateway payments confirm via webhook');
  const out = await orders.confirmPayment(req.ctx, p.id, { source: 'STAFF', reference: b.reference });
  await audit(null, req.ctx, { action: 'PAYMENT_CONFIRM', targetType: 'payment', targetId: p.id, targetLabel: p.payment_no, newData: { method: p.method, amount: p.amount, reference: b.reference } });
  res.json(out);
});

r.post('/payments/:id/cancel', perm('pos.open'), async (req, res) => {
  const p = await one({ query }, `UPDATE payments SET status = 'CANCELLED', updated_at = now() WHERE id = $1 AND status = 'PENDING' RETURNING *`, [req.params.id]);
  if (!p) throw fail('PAYMENT_NOT_PENDING');
  res.json(p);
});

/** TEST MODE ONLY: simulate the gateway sending a signed "PAID" webhook. */
r.post('/payments/:id/simulate', perm('pos.open'), async (req, res) => {
  if (config.isProd) throw fail('FORBIDDEN', 'Simulation is disabled in production');
  const p = await one({ query }, 'SELECT * FROM payments WHERE id = $1', [req.params.id]);
  if (!p) throw fail('NOT_FOUND');
  if (p.provider !== 'mock') throw fail('CONFLICT', 'Only mock-gateway payments can be simulated');
  const body = { eventId: `evt_${randomToken(8)}`, providerRef: p.provider_ref, paymentNo: p.payment_no, status: 'PAID', amount: Number(p.amount) };
  const out = await orders.handleGatewayWebhook('mock', { ...body, raw: body });
  res.json(out);
});

// ---------------------------------------------------------------- shifts
r.get('/shifts/current', perm('pos.open'), async (req, res) => {
  const s = await orders.openShiftFor({ query }, req.ctx.staff.id);
  res.json(s ? await shifts.shiftSummary({ query }, s.id) : null);
});
r.post('/shifts/open', perm('pos.shift'), async (req, res) => {
  const b = parse(z.object({ openingCash: zMoney, note: z.string().max(300).optional() }), req.body);
  res.status(201).json(await tx((db) => shifts.openShift(db, req.ctx, b)));
});
r.post('/shifts/cash', perm('pos.cash_movement'), async (req, res) => {
  const b = parse(z.object({ type: z.enum(['CASH_IN', 'CASH_OUT']), amount: zPosMoney, reason: zReason }), req.body);
  res.json(await tx((db) => shifts.cashMovement(db, req.ctx, b)));
});
r.post('/shifts/:id/close', perm('pos.shift'), async (req, res) => {
  const b = parse(z.object({ actualCash: zMoney, note: z.string().max(300).optional() }), req.body);
  res.json(await tx((db) => shifts.closeShift(db, req.ctx, req.params.id, b)));
});
r.get('/shifts', permAny('pos.shift', 'report.view'), async (req, res) => {
  const w = where();
  if (!req.ctx.staff.permissions.has('report.view')) w.add('s.staff_id = $?', req.ctx.staff.id);
  if (req.query.status) w.add('s.status = $?', req.query.status);
  if (req.query.staffId) w.add('s.staff_id = $?', req.query.staffId);
  res.json(await paginate(`SELECT s.*, st.first_name || ' ' || st.last_name AS staff_name, b.name AS branch_name FROM shifts s JOIN staff st ON st.id = s.staff_id LEFT JOIN branches b ON b.id = s.branch_id ${w.sql()}`, w.params, req.query, 'opened_at DESC'));
});
r.get('/shifts/:id', permAny('pos.shift', 'report.view'), async (req, res) => res.json(await shifts.shiftSummary({ query }, req.params.id)));

// ---------------------------------------------------------------- receipts
r.get('/receipts', permAny('pos.open', 'transaction.view'), async (req, res) => {
  const w = where();
  if (req.query.q) w.add('(r.receipt_no ILIKE $? OR r.data->>\'orderNo\' ILIKE $?)', `%${req.query.q}%`, `%${req.query.q}%`);
  if (req.query.type) w.add('r.type = $?', req.query.type);
  res.json(await paginate(`SELECT r.id, r.receipt_no, r.type, r.order_id, r.created_at, r.print_count, r.reprint_count, (r.data->'totals'->>'grandTotal')::numeric AS total, r.data->>'refundAmount' AS refund_amount FROM receipts r ${w.sql()}`, w.params, req.query, 'r.created_at DESC'));
});
r.get('/receipts/:id', permAny('pos.open', 'transaction.view'), async (req, res) => {
  const rc = await one({ query }, 'SELECT * FROM receipts WHERE id = $1', [req.params.id]);
  if (!rc) throw fail('NOT_FOUND');
  res.json({ ...rc, publicUrl: `${config.publicUrl}/r/${rc.data.qrToken}` });
});
r.post('/receipts/:id/print', perm('pos.open'), async (req, res) => {
  const b = parse(z.object({ reprint: z.boolean().default(false), printer: z.string().max(100).optional() }), req.body);
  const rc = await tx(async (db) => {
    const row = await one(db, 'SELECT * FROM receipts WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!row) throw fail('NOT_FOUND');
    const isReprint = b.reprint || row.print_count > 0;
    if (isReprint && !req.ctx.staff.permissions.has('pos.reprint')) throw fail('FORBIDDEN', 'Reprint not permitted', { permission: 'pos.reprint' });
    const upd = await one(db, `UPDATE receipts SET print_count = print_count + 1, reprint_count = reprint_count + $2 WHERE id = $1 RETURNING *`, [row.id, isReprint ? 1 : 0]);
    if (isReprint) await audit(db, req.ctx, { action: 'RECEIPT_REPRINT', targetType: 'receipt', targetId: row.id, targetLabel: row.receipt_no, newData: { reprintCount: upd.reprint_count, printer: b.printer } });
    return { ...upd, isReprint };
  });
  res.json(rc);
});
r.post('/receipts/:id/email', perm('pos.open'), async (req, res) => {
  const b = parse(z.object({ email: z.string().email() }), req.body);
  if (!emailConfigured()) throw fail('CONFLICT', 'Email delivery is not configured (Settings > Integration)');
  const rc = await one({ query }, 'SELECT * FROM receipts WHERE id = $1', [req.params.id]);
  if (!rc) throw fail('NOT_FOUND');
  const url = `${config.publicUrl}/r/${rc.data.qrToken}`;
  await sendEmail({ to: b.email, subject: `${rc.data.store.name} — Receipt ${rc.receipt_no}`, text: `Your receipt: ${url}`, html: `<p>Thank you for visiting ${escapeHtml(rc.data.store.name)}.</p><p><a href="${escapeHtml(url)}">View receipt ${escapeHtml(rc.receipt_no)}</a></p>` });
  await query('UPDATE receipts SET email_to = $2 WHERE id = $1', [rc.id, b.email]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- transactions (ledger)
r.get('/transactions', perm('transaction.view'), async (req, res) => {
  const w = where();
  if (req.query.type) w.add('t.type = $?', req.query.type);
  if (req.query.cardId) w.add('t.card_id = $?', req.query.cardId);
  if (req.query.memberId) w.add('t.member_id = $?', req.query.memberId);
  if (req.query.staffId) w.add('t.staff_id = $?', req.query.staffId);
  if (req.query.machineId) w.add('t.machine_id = $?', req.query.machineId);
  if (req.query.branchId) w.add('t.branch_id = $?', req.query.branchId);
  if (req.query.orderId) w.add('t.order_id = $?', req.query.orderId);
  if (req.query.q) w.add('(t.txn_no ILIKE $? OR c.card_number LIKE $? OR t.reference ILIKE $?)', `%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`);
  if (req.query.range || req.query.from) { const d = dateRange(req.query); w.add(`t.created_at >= ($?::timestamp AT TIME ZONE '${d.tz}')`, d.start).add(`t.created_at < ($?::timestamp AT TIME ZONE '${d.tz}')`, d.end); }
  res.json(await paginate(`SELECT t.id, t.txn_no, t.type, t.amount, t.bonus, t.balance_before, t.balance_after, t.points_delta, t.stamps_delta, t.cash_amount, t.created_at, t.reason,
      t.reversed_by, t.reversal_of, c.card_number, m.member_code, m.first_name || ' ' || m.last_name AS member_name, s.first_name AS staff_name, mc.name AS machine_name,
      d.name AS device_name, b.name AS branch_name, o.order_no
    FROM transactions t JOIN cards c ON c.id = t.card_id LEFT JOIN members m ON m.id = t.member_id LEFT JOIN staff s ON s.id = t.staff_id
    LEFT JOIN machines mc ON mc.id = t.machine_id LEFT JOIN devices d ON d.id = t.device_id LEFT JOIN branches b ON b.id = t.branch_id LEFT JOIN orders o ON o.id = t.order_id ${w.sql()}`,
  w.params, req.query, 't.created_at DESC'));
});

/** Full trace of one transaction: card, member, staff/device, payment, order, branch, approver, reversal chain. */
r.get('/transactions/:id', perm('transaction.view'), async (req, res) => {
  const t = await one({ query }, `SELECT t.*, c.card_number, c.card_type, m.member_code, m.first_name || ' ' || m.last_name AS member_name, m.phone AS member_phone,
      s.first_name || ' ' || s.last_name AS staff_name, s.employee_code, a.first_name || ' ' || a.last_name AS approver_name, mc.name AS machine_name, mc.machine_code,
      d.name AS device_name, d.device_code, b.name AS branch_name, mr.name AS merchant_name, o.order_no, p.payment_no, p.method AS payment_method, p.status AS payment_status,
      p.provider_ref, rv.txn_no AS reversed_by_no, ro.txn_no AS reversal_of_no, rd.code AS redemption_code
    FROM transactions t JOIN cards c ON c.id = t.card_id LEFT JOIN members m ON m.id = t.member_id LEFT JOIN staff s ON s.id = t.staff_id LEFT JOIN staff a ON a.id = t.approver_id
    LEFT JOIN machines mc ON mc.id = t.machine_id LEFT JOIN devices d ON d.id = t.device_id LEFT JOIN branches b ON b.id = t.branch_id LEFT JOIN merchants mr ON mr.id = t.merchant_id
    LEFT JOIN orders o ON o.id = t.order_id LEFT JOIN payments p ON p.id = t.payment_id LEFT JOIN transactions rv ON rv.id = t.reversed_by LEFT JOIN transactions ro ON ro.id = t.reversal_of
    LEFT JOIN redemptions rd ON rd.id = t.redemption_id WHERE t.id = $1 OR t.txn_no = $2`, [/^[0-9a-f-]{36}$/.test(req.params.id) ? req.params.id : null, req.params.id]);
  if (!t) throw fail('NOT_FOUND', 'Transaction not found');
  res.json(t);
});

r.post('/transactions/:id/refund', perm('transaction.refund'), async (req, res) => {
  const b = parse(z.object({ reason: zReason, approval: z.any().optional() }), req.body);
  const approverId = await requireApproval(req.ctx, 'transaction.refund', b.approval);
  const out = await orders.refundTransaction(req.ctx, req.params.id, { reason: b.reason, approverId });
  res.json({ reversalNo: out.reversal.txn_no, refundNo: out.refund.refund_no, receiptId: out.receipt.id });
});

// ---------------------------------------------------------------- packages
r.get('/packages', requireStaff, async (req, res) => {
  const all = req.query.all === '1';
  res.json({ items: await many({ query }, `SELECT * FROM topup_packages ${all ? '' : `WHERE status = 'ACTIVE' AND (start_at IS NULL OR start_at <= now()) AND (end_at IS NULL OR end_at > now())`} ORDER BY sort, pay_amount`) });
});
const pkgSchema = z.object({
  name: z.string().trim().min(1).max(100), payAmount: zPosMoney, bonusAmount: zMoney.default(0), pointBonus: z.number().int().min(0).default(0), stampBonus: z.number().int().min(0).default(0),
  startAt: z.string().nullable().optional(), endAt: z.string().nullable().optional(), memberOnly: z.boolean().default(false), tierIds: z.array(z.string().uuid()).default([]),
  branchIds: z.array(z.string().uuid()).default([]), usageLimit: z.number().int().min(1).nullable().optional(), perCardLimit: z.number().int().min(1).nullable().optional(),
  imageMediaId: zOptUuid, sort: z.number().int().default(0), status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});
const pkgVals = (b) => [b.name, b.payAmount, b.bonusAmount, b.pointBonus, b.stampBonus, b.startAt || null, b.endAt || null, b.memberOnly, b.tierIds, b.branchIds, b.usageLimit ?? null, b.perCardLimit ?? null, b.imageMediaId || null, b.sort, b.status];
r.post('/packages', perm('promotion.manage'), async (req, res) => {
  const b = parse(pkgSchema, req.body);
  const row = await tx(async (db) => {
    const x = await one(db, `INSERT INTO topup_packages(name, pay_amount, bonus_amount, point_bonus, stamp_bonus, start_at, end_at, member_only, tier_ids, branch_ids, usage_limit, per_card_limit, image_media_id, sort, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, pkgVals(b));
    await audit(db, req.ctx, { action: 'PACKAGE_CREATE', targetType: 'package', targetId: x.id, targetLabel: x.name, newData: x });
    return x;
  });
  res.status(201).json(row);
});
r.put('/packages/:id', perm('promotion.manage'), async (req, res) => {
  const b = parse(pkgSchema, req.body);
  const row = await tx(async (db) => {
    const old = await one(db, 'SELECT * FROM topup_packages WHERE id = $1', [req.params.id]);
    if (!old) throw fail('NOT_FOUND');
    const x = await one(db, `UPDATE topup_packages SET name=$1, pay_amount=$2, bonus_amount=$3, point_bonus=$4, stamp_bonus=$5, start_at=$6, end_at=$7, member_only=$8, tier_ids=$9, branch_ids=$10,
      usage_limit=$11, per_card_limit=$12, image_media_id=$13, sort=$14, status=$15 WHERE id = $16 RETURNING *`, [...pkgVals(b), old.id]);
    await audit(db, req.ctx, { action: 'PACKAGE_EDIT', targetType: 'package', targetId: x.id, targetLabel: x.name, oldData: old, newData: x });
    return x;
  });
  res.json(row);
});
r.delete('/packages/:id', perm('promotion.manage'), async (req, res) => {
  await tx(async (db) => {
    const old = await one(db, 'SELECT * FROM topup_packages WHERE id = $1', [req.params.id]);
    if (!old) throw fail('NOT_FOUND');
    const used = await one(db, 'SELECT 1 FROM order_items WHERE package_id = $1 LIMIT 1', [old.id]);
    if (used) await db.query(`UPDATE topup_packages SET status = 'INACTIVE' WHERE id = $1`, [old.id]);
    else await db.query('DELETE FROM topup_packages WHERE id = $1', [old.id]);
    await audit(db, req.ctx, { action: used ? 'PACKAGE_DEACTIVATE' : 'PACKAGE_DELETE', targetType: 'package', targetId: old.id, targetLabel: old.name });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- products
r.get('/products', permAny('product.view', 'pos.open'), async (req, res) => {
  const w = where();
  if (req.query.status) w.add('p.status = $?', req.query.status); else if (req.query.all !== '1') w.add(`p.status = 'ACTIVE'`);
  if (req.query.merchantId) w.add('p.merchant_id = $?', req.query.merchantId);
  if (req.query.category) w.add('p.category = $?', req.query.category);
  if (req.query.q) w.add('(p.name ILIKE $? OR p.sku ILIKE $? OR p.barcode = $?)', `%${req.query.q}%`, `%${req.query.q}%`, req.query.q);
  res.json(await paginate(`SELECT p.*, m.name AS merchant_name FROM products p LEFT JOIN merchants m ON m.id = p.merchant_id ${w.sql()}`, w.params, { pageSize: 200, ...req.query }, 'p.sort, p.name'));
});
const productSchema = z.object({
  sku: z.string().max(40).optional().or(z.literal('')), barcode: z.string().max(60).optional().or(z.literal('')), name: z.string().trim().min(1).max(120), category: z.string().max(40).default('GENERAL'),
  kind: z.enum(['FOOD', 'MERCHANDISE', 'SERVICE']).default('FOOD'), merchantId: zOptUuid, branchId: zOptUuid, price: zMoney, cost: zMoney.nullable().optional(), imageMediaId: zOptUuid,
  trackStock: z.boolean().default(false), lowStockThreshold: z.number().int().min(0).default(0), taxable: z.boolean().default(true), status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'), sort: z.number().int().default(0),
});
const prodVals = (b) => [b.sku || null, b.barcode || null, b.name, b.category, b.kind, b.merchantId || null, b.branchId || null, b.price, b.cost ?? null, b.imageMediaId || null, b.trackStock, b.lowStockThreshold, b.taxable, b.status, b.sort];
r.post('/products', perm('product.manage'), async (req, res) => {
  const b = parse(productSchema.extend({ stock: z.number().int().min(0).default(0) }), req.body);
  const row = await tx(async (db) => {
    const x = await one(db, `INSERT INTO products(sku, barcode, name, category, kind, merchant_id, branch_id, price, cost, image_media_id, track_stock, low_stock_threshold, taxable, status, sort)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, prodVals(b));
    if (b.stock > 0) await moveStock(db, req.ctx, { kind: 'PRODUCT', id: x.id, type: 'IN', qty: b.stock, reason: 'Initial stock' });
    await audit(db, req.ctx, { action: 'PRODUCT_CREATE', targetType: 'product', targetId: x.id, targetLabel: x.name, newData: x });
    return x;
  });
  res.status(201).json(row);
});
r.put('/products/:id', perm('product.manage'), async (req, res) => {
  const b = parse(productSchema, req.body);
  const row = await tx(async (db) => {
    const old = await one(db, 'SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (!old) throw fail('NOT_FOUND');
    const x = await one(db, `UPDATE products SET sku=$1, barcode=$2, name=$3, category=$4, kind=$5, merchant_id=$6, branch_id=$7, price=$8, cost=$9, image_media_id=$10, track_stock=$11,
      low_stock_threshold=$12, taxable=$13, status=$14, sort=$15 WHERE id = $16 RETURNING *`, [...prodVals(b), old.id]);
    await audit(db, req.ctx, { action: 'PRODUCT_EDIT', targetType: 'product', targetId: x.id, targetLabel: x.name, oldData: old, newData: x });
    return x;
  });
  res.json(row);
});
r.delete('/products/:id', perm('product.manage'), async (req, res) => {
  await tx(async (db) => {
    const old = await one(db, 'SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (!old) throw fail('NOT_FOUND');
    await db.query(`UPDATE products SET status = 'INACTIVE' WHERE id = $1`, [old.id]);
    await audit(db, req.ctx, { action: 'PRODUCT_DEACTIVATE', targetType: 'product', targetId: old.id, targetLabel: old.name });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- stock
r.post('/stock/move', perm('stock.manage'), async (req, res) => {
  const b = parse(z.object({ kind: z.enum(['REWARD', 'PRODUCT']), id: z.string().uuid(), type: z.enum(['IN', 'OUT', 'ADJUST']), qty: z.number().int().min(0).max(100000), reason: z.string().max(300).optional() }), req.body);
  if (b.type !== 'ADJUST' && b.qty === 0) throw fail('VALIDATION_ERROR', 'Quantity must be greater than 0');
  res.json(await tx((db) => moveStock(db, req.ctx, b)));
});
r.get('/stock/movements', permAny('stock.manage', 'report.view'), async (req, res) => {
  const w = where();
  if (req.query.kind) w.add('sm.item_kind = $?', req.query.kind);
  if (req.query.id) w.add('(sm.reward_id = $? OR sm.product_id = $?)', req.query.id, req.query.id);
  res.json(await paginate(`SELECT sm.*, coalesce(rw.name, p.name) AS item_name, s.first_name AS staff_name FROM stock_movements sm LEFT JOIN rewards rw ON rw.id = sm.reward_id LEFT JOIN products p ON p.id = sm.product_id LEFT JOIN staff s ON s.id = sm.staff_id ${w.sql()}`, w.params, req.query, 'sm.created_at DESC'));
});

export default r;
export { getGateway };
