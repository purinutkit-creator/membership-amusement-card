// Members, cards, loyalty (stamps/points), balance adjustments.
import { Router } from 'express';
import { tx, one, many, query } from '../db/pool.js';
import { parse, z, zPhone, zPin6, zReason, zPosMoney, zOptUuid } from '../lib/validate.js';
import { fail } from '../lib/errors.js';
import { perm, permAny, requireStaff } from '../middleware/auth.js';
import { requireApproval } from '../services/auth.js';
import * as members from '../services/members.js';
import * as cards from '../services/cards.js';
import * as loyalty from '../services/loyalty.js';
import { reconcileCard } from '../services/ledger.js';
import { audit } from '../services/audit.js';
import { getSettings } from '../services/settings.js';
import { openShiftFor } from '../services/orders.js';
import { paginate, where } from './_util.js';
import { config } from '../config.js';

const r = Router();
r.use(requireStaff);

// ================================================================ MEMBERS
r.get('/members', perm('member.view'), async (req, res) => {
  const w = where().add(`m.status NOT IN ('MERGED','DELETED')`);
  if (req.query.status) w.add('m.status = $?', req.query.status);
  if (req.query.tierId) w.add('m.tier_id = $?', req.query.tierId);
  if (req.query.q) {
    const q = String(req.query.q).trim();
    w.add(`(m.phone LIKE $? OR m.member_code ILIKE $? OR (m.first_name || ' ' || m.last_name) ILIKE $? OR m.nickname ILIKE $? OR m.email ILIKE $?
            OR EXISTS (SELECT 1 FROM cards c WHERE c.member_id = m.id AND c.card_number LIKE $?))`, `%${q.replace(/[\s-]/g, '')}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const sort = { name: 'first_name, last_name', joined: 'created_at DESC', spend: 'total_spend DESC', points: 'lifetime_points DESC' }[req.query.sort] || 'created_at DESC';
  res.json(await paginate(
    `SELECT m.id, m.member_code, m.phone, m.first_name, m.last_name, m.nickname, m.email, m.status, m.join_date, m.total_spend, m.total_topup, m.total_play,
            m.visit_count, m.lifetime_points, m.created_at, m.tier_id, t.name AS tier_name, t.color AS tier_color,
            (SELECT coalesce(sum(balance),0) FROM cards c WHERE c.member_id = m.id AND c.status = 'ACTIVE') AS balance,
            (SELECT coalesce(sum(points),0)::int FROM cards c WHERE c.member_id = m.id AND c.status = 'ACTIVE') AS points,
            (SELECT coalesce(sum(stamps),0)::int FROM cards c WHERE c.member_id = m.id AND c.status = 'ACTIVE') AS stamps,
            (SELECT count(*)::int FROM cards c WHERE c.member_id = m.id) AS card_count
       FROM members m LEFT JOIN member_tiers t ON t.id = m.tier_id ${w.sql()}`, w.params, req.query, sort));
});

r.get('/members/lookup', perm('member.view'), async (req, res) => {
  const { phone, code } = req.query;
  let m = null;
  if (phone) m = await one({ query }, `SELECT id FROM members WHERE phone = $1 AND status NOT IN ('MERGED','DELETED')`, [String(phone).replace(/[\s-]/g, '')]);
  else if (code) m = await one({ query }, `SELECT id FROM members WHERE upper(member_code) = upper($1)`, [code]);
  if (!m) throw fail('MEMBER_NOT_FOUND');
  res.json(await members.memberSummary({ query }, m.id));
});

r.get('/members/:id', perm('member.view'), async (req, res) => res.json(await members.memberSummary({ query }, req.params.id)));

const memberSchema = z.object({
  phone: zPhone, firstName: z.string().trim().min(1).max(80), lastName: z.string().trim().min(1).max(80), nickname: z.string().max(40).optional(),
  email: z.string().email().optional().or(z.literal('')), birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED']).optional().or(z.literal('')), address: z.string().max(500).optional(),
  pin: zPin6.optional(), note: z.string().max(1000).optional(), customFields: z.record(z.any()).optional(), language: z.enum(['th', 'en', 'zh']).optional(),
});

r.post('/members', perm('member.create'), async (req, res) => {
  const b = parse(memberSchema, req.body);
  const m = await tx((db) => members.createMember(db, req.ctx, { ...b, email: b.email || null, birthday: b.birthday || null, gender: b.gender || null }));
  res.status(201).json(await members.memberSummary({ query }, m.id));
});

r.put('/members/:id', perm('member.edit'), async (req, res) => {
  const b = parse(memberSchema.partial().extend({ tierId: zOptUuid, tierLocked: z.boolean().optional() }), req.body);
  if (b.tierId !== undefined && !req.ctx.staff.permissions.has('member.suspend') && !req.ctx.staff.permissions.has('settings.edit')) throw fail('FORBIDDEN', 'Manual tier change requires manager rights');
  if (b.pin) throw fail('VALIDATION_ERROR', 'Use reset PIN');
  await tx((db) => members.updateMember(db, req.ctx, req.params.id, b));
  res.json(await members.memberSummary({ query }, req.params.id));
});

r.post('/members/:id/status', async (req, res) => {
  const b = parse(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'BLOCKED', 'DELETED']), reason: z.string().max(500).optional() }), req.body);
  const need = b.status === 'DELETED' ? 'member.delete' : 'member.suspend';
  if (!req.ctx.staff.permissions.has(need)) throw fail('FORBIDDEN');
  if (b.status !== 'ACTIVE' && !b.reason) throw fail('VALIDATION_ERROR', 'Reason is required');
  await tx((db) => members.setMemberStatus(db, req.ctx, req.params.id, b.status, b.reason));
  res.json({ ok: true });
});

r.post('/members/:id/reset-pin', perm('member.reset_pin'), async (req, res) => {
  const b = parse(z.object({ pin: zPin6 }), req.body);
  await tx((db) => members.resetMemberPin(db, req.ctx, req.params.id, b.pin));
  res.json({ ok: true });
});

r.post('/members/merge', perm('member.merge'), async (req, res) => {
  const b = parse(z.object({ sourceId: z.string().uuid(), targetId: z.string().uuid(), reason: zReason, approval: z.any().optional() }), req.body);
  const approverId = await requireApproval(req.ctx, 'member.merge', b.approval);
  res.json(await tx((db) => members.mergeMembers(db, req.ctx, { ...b, approverId })));
});

const TIMELINE_FILTER = {
  topup: `t.type IN ('TOP_UP','PROMOTION_BONUS')`, play: `t.type = 'PLAY'`, point: `t.points_delta <> 0`, stamp: `t.stamps_delta <> 0`,
  reward: `t.type IN ('REWARD_REDEMPTION','REDEMPTION_CANCEL')`, refund: `t.type IN ('REFUND','DEPOSIT_REFUND','REVERSAL')`,
  adjustment: `t.type IN ('BALANCE_ADJUSTMENT','POINT_ADD','POINT_REMOVE','STAMP_ADD','STAMP_REMOVE')`, food: `t.type IN ('FOOD_PURCHASE','PURCHASE')`,
};

export async function timeline(filterCol, id, q) {
  const w = where().add(`t.${filterCol} = $?`, id);
  if (q.type && TIMELINE_FILTER[q.type]) w.add(TIMELINE_FILTER[q.type]);
  return paginate(
    `SELECT t.id, t.txn_no, t.type, t.amount, t.bonus, t.balance_before, t.balance_after, t.points_delta, t.points_after, t.stamps_delta, t.stamps_after,
            t.reason, t.reference, t.created_at, t.reversed_by, t.reversal_of, t.promotions, c.card_number, mc.name AS machine_name, s.first_name AS staff_name,
            o.order_no, b.name AS branch_name, d.name AS device_name
       FROM transactions t JOIN cards c ON c.id = t.card_id LEFT JOIN machines mc ON mc.id = t.machine_id LEFT JOIN staff s ON s.id = t.staff_id
       LEFT JOIN orders o ON o.id = t.order_id LEFT JOIN branches b ON b.id = t.branch_id LEFT JOIN devices d ON d.id = t.device_id ${w.sql()}`, w.params, q, 't.created_at DESC');
}

r.get('/members/:id/timeline', perm('member.view'), async (req, res) => res.json(await timeline('member_id', req.params.id, req.query)));
r.get('/members/:id/redemptions', perm('member.view'), async (req, res) => {
  res.json({ items: await many({ query }, `SELECT r.*, rw.name AS reward_name FROM redemptions r JOIN rewards rw ON rw.id = r.reward_id WHERE r.member_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [req.params.id]) });
});
r.get('/members/:id/consents', perm('member.view'), async (req, res) => {
  res.json({ items: await many({ query }, `SELECT pc.*, pp.kind, pp.version FROM privacy_consents pc JOIN privacy_policies pp ON pp.id = pc.policy_id WHERE pc.member_id = $1 ORDER BY accepted_at DESC`, [req.params.id]) });
});

// ================================================================ CARDS
r.get('/cards', perm('card.view'), async (req, res) => {
  const w = where();
  if (req.query.status) w.add('c.status = $?', req.query.status);
  if (req.query.type) w.add('c.card_type = $?', req.query.type);
  if (req.query.memberId) w.add('c.member_id = $?', req.query.memberId);
  if (req.query.batchId) w.add('c.batch_id = $?', req.query.batchId);
  if (req.query.q) w.add(`(c.card_number LIKE $? OR c.rfid_uid ILIKE $? OR m.phone LIKE $? OR (m.first_name || ' ' || m.last_name) ILIKE $?)`, `%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`);
  res.json(await paginate(
    `SELECT c.id, c.card_number, c.card_type, c.status, c.balance, c.points, c.stamps, c.issued_at, c.expires_at, c.last_used_at, c.created_at, c.member_id,
            m.member_code, m.first_name, m.last_name, m.phone, b.batch_no
       FROM cards c LEFT JOIN members m ON m.id = c.member_id LEFT JOIN card_batches b ON b.id = c.batch_id ${w.sql()}`, w.params, req.query, 'c.created_at DESC, c.card_number'));
});

/** Identify a card by any method: typed number, barcode, QR, RFID/NFC reader. */
r.get('/cards/lookup', permAny('card.view', 'pos.open', 'stamp.add', 'reward.redeem'), async (req, res) => {
  const card = await cards.findCard({ query }, req.query.identifier);
  res.json(await cards.cardView({ query }, card));
});

r.get('/cards/available', permAny('card.issue', 'card.replace'), async (req, res) => {
  res.json({ items: await many({ query }, `SELECT id, card_number, card_type FROM cards WHERE status = 'INACTIVE' AND balance = 0 ORDER BY created_at DESC, card_number LIMIT $1`, [Math.min(Number(req.query.limit) || 20, 100)]) });
});

r.get('/cards/batches', permAny('card.batch', 'card.view'), async (req, res) => {
  res.json(await paginate(`SELECT b.*, s.first_name AS created_by_name, (SELECT count(*)::int FROM cards c WHERE c.batch_id = b.id AND c.status <> 'INACTIVE') AS issued FROM card_batches b LEFT JOIN staff s ON s.id = b.created_by`, [], req.query, 'b.created_at DESC'));
});

r.get('/cards/batches/:id/export', perm('card.batch'), async (req, res) => {
  const rows = await many({ query }, `SELECT c.card_number, c.card_type, c.status, c.rfid_uid, (SELECT token FROM qr_tokens q WHERE q.kind = 'CARD_PORTAL' AND q.target_id = c.id AND q.revoked_at IS NULL ORDER BY created_at DESC LIMIT 1) AS token
     FROM cards c WHERE c.batch_id = $1 ORDER BY c.card_number`, [req.params.id]);
  const lines = ['card_number,barcode,qr_url,card_type,status,rfid_uid', ...rows.map((x) => [x.card_number, x.card_number, x.token ? `${config.publicUrl}/c/${x.token}` : '', x.card_type, x.status, x.rfid_uid || ''].join(','))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cards-${req.params.id}.csv"`);
  res.send('﻿' + lines.join('\n'));
});

r.post('/cards', perm('card.batch'), async (req, res) => {
  const b = parse(z.object({
    numbers: z.array(z.string()).max(5000).optional(), count: z.number().int().min(1).max(5000).optional(), cardType: z.enum(['MEMBER', 'GUEST']).default('MEMBER'),
    prefix: z.string().regex(/^[0-9]{0,6}$/).optional(), rfidUids: z.record(z.string()).optional(), note: z.string().max(200).optional(),
  }), req.body);
  if (!b.numbers?.length && !b.count) throw fail('VALIDATION_ERROR', 'Provide card numbers or a count');
  const out = await tx(async (db) => {
    const created = await cards.createCards(db, req.ctx, b);
    for (const c of created.cards) await cards.ensurePortalToken(db, c.id);
    return created;
  });
  res.status(201).json({ batch: out.batch, count: out.cards.length, cards: out.cards.slice(0, 50).map((c) => ({ id: c.id, cardNumber: c.card_number })) });
});

/** CSV import: one card per line "card_number[,rfid_uid]". */
r.post('/cards/import', perm('card.batch'), async (req, res) => {
  const b = parse(z.object({ csv: z.string().min(12).max(500000), cardType: z.enum(['MEMBER', 'GUEST']).default('MEMBER') }), req.body);
  const numbers = []; const rfidUids = {};
  for (const line of b.csv.split(/\r?\n/)) {
    const [num, uid] = line.split(/[,;\t]/).map((x) => x?.trim());
    if (!num || /card/i.test(num)) continue;
    numbers.push(num);
    if (uid) rfidUids[num] = uid;
  }
  const out = await tx(async (db) => {
    const created = await cards.createCards(db, req.ctx, { numbers, rfidUids, cardType: b.cardType, note: 'CSV import' });
    for (const c of created.cards) await cards.ensurePortalToken(db, c.id);
    return created;
  });
  res.status(201).json({ batch: out.batch, count: out.cards.length });
});

r.get('/cards/:id', perm('card.view'), async (req, res) => {
  const card = await cards.getCardById({ query }, req.params.id);
  const view = await cards.cardView({ query }, card);
  const token = await cards.ensurePortalToken({ query }, card.id).catch(() => null);
  const recon = await reconcileCard({ query }, card.id);
  const batch = card.batch_id ? await one({ query }, 'SELECT batch_no FROM card_batches WHERE id = $1', [card.batch_id]) : null;
  res.json({ ...view, portalUrl: token ? `${config.publicUrl}/c/${token}` : null, reconciliation: recon, batchNo: batch?.batch_no });
});

r.get('/cards/:id/history', perm('card.view'), async (req, res) => res.json(await timeline('card_id', req.params.id, req.query)));
r.get('/cards/:id/reconcile', perm('card.view'), async (req, res) => res.json(await reconcileCard({ query }, req.params.id)));

/** Direct issue (no payment) — only when deposit is zero or explicitly waived. Paid deposits go through POS. */
r.post('/cards/:id/issue', perm('card.issue'), async (req, res) => {
  const b = parse(z.object({ memberId: zOptUuid, cardType: z.enum(['MEMBER', 'GUEST']).optional(), waiveReason: z.string().max(200).optional(), rfidUid: z.string().max(64).optional() }), req.body);
  const s = await getSettings(req.ctx.branchId);
  if (Number(s.card.deposit) > 0 && !b.waiveReason) throw fail('CONFLICT', `Card deposit ฿${s.card.deposit} must be paid at POS (or provide a waive reason)`);
  const out = await tx((db) => cards.issueCard(db, req.ctx, { cardId: req.params.id, memberId: b.memberId, cardType: b.cardType, deposit: 0, waiveReason: b.waiveReason, rfidUid: b.rfidUid }));
  res.json(await cards.cardView({ query }, out.card));
});

for (const [path, status, permission] of [['block', 'BLOCKED', 'card.block'], ['lost', 'LOST', 'card.block'], ['unblock', 'ACTIVE', 'card.unblock']]) {
  r.post(`/cards/:id/${path}`, perm(permission), async (req, res) => {
    const b = parse(z.object({ reason: status === 'ACTIVE' ? z.string().max(500).optional() : zReason }), req.body);
    const c = await tx((db) => cards.setCardStatus(db, req.ctx, req.params.id, status, b.reason));
    res.json(await cards.cardView({ query }, c));
  });
}

r.post('/cards/:id/replace', perm('card.replace'), async (req, res) => {
  const b = parse(z.object({ newCardId: z.string().uuid().optional(), newCardIdentifier: z.string().optional(), reason: zReason, chargeFeeFromBalance: z.boolean().optional() }), req.body);
  const s = await getSettings(req.ctx.branchId);
  const out = await tx(async (db) => {
    let newCardId = b.newCardId;
    if (!newCardId && b.newCardIdentifier) newCardId = (await cards.findCard(db, b.newCardIdentifier)).id;
    if (!newCardId) throw fail('VALIDATION_ERROR', 'Select or scan the new card');
    return cards.replaceCard(db, req.ctx, { oldCardId: req.params.id, newCardId, reason: b.reason, fee: b.chargeFeeFromBalance ? Number(s.card.replacementFee || 0) : 0 });
  });
  res.json({ oldCard: await cards.cardView({ query }, out.oldCard), newCard: await cards.cardView({ query }, out.newCard), transactions: out.transactions.map((t) => t.txn_no) });
});

r.post('/cards/:id/adjust', perm('card.adjust_balance'), async (req, res) => {
  const b = parse(z.object({ delta: z.number().refine((n) => n !== 0 && Math.abs(n) <= 1_000_000, 'Invalid amount'), reason: zReason, approval: z.any().optional() }), req.body);
  const approverId = await requireApproval(req.ctx, 'card.adjust_balance', b.approval);
  const out = await tx((db) => loyalty.adjustBalance(db, req.ctx, { cardId: req.params.id, delta: Math.round(b.delta * 100) / 100, reason: b.reason, approverId }));
  res.json({ txnNo: out.txn.txn_no, card: await cards.cardView({ query }, out.card) });
});

r.post('/cards/transfer', perm('card.transfer'), async (req, res) => {
  const b = parse(z.object({ fromCardId: z.string().uuid(), toCardId: z.string().uuid(), amount: zPosMoney, reason: zReason, approval: z.any().optional() }), req.body);
  const approverId = await requireApproval(req.ctx, 'card.transfer', b.approval);
  const txns = await tx((db) => cards.transferBalance(db, req.ctx, { ...b, approverId }));
  res.json({ transactions: txns.map((t) => t.txn_no) });
});

r.post('/cards/:id/return', perm('card.return'), async (req, res) => {
  const b = parse(z.object({ refundBalance: z.boolean().optional(), reason: z.string().max(300).optional(), approval: z.any().optional() }), req.body);
  let approverId = null;
  if (b.refundBalance) {
    if (!req.ctx.staff.permissions.has('topup.refund')) throw fail('FORBIDDEN', 'Refunding balance requires topup.refund');
    approverId = await requireApproval(req.ctx, 'topup.refund', b.approval);
  }
  const shift = await openShiftFor({ query }, req.ctx.staff.id);
  const out = await tx((db) => cards.returnCard(db, req.ctx, { cardId: req.params.id, refundBalance: b.refundBalance, reason: b.reason, approverId, shiftId: shift?.id }));
  res.json({ cashOut: out.cashOut, transactions: out.transactions.map((t) => t.txn_no) });
});

r.post('/cards/:id/link', perm('card.issue'), async (req, res) => {
  const b = parse(z.object({ memberId: z.string().uuid() }), req.body);
  const c = await tx((db) => cards.linkCardToMember(db, req.ctx, { cardId: req.params.id, memberId: b.memberId }));
  res.json(await cards.cardView({ query }, c));
});

r.post('/cards/:id/rfid', perm('card.issue'), async (req, res) => {
  const b = parse(z.object({ uid: z.string().trim().min(4).max(64).nullable() }), req.body);
  await tx(async (db) => {
    const c = await one(db, 'SELECT * FROM cards WHERE id = $1', [req.params.id]);
    if (!c) throw fail('CARD_NOT_FOUND');
    await db.query('UPDATE cards SET rfid_uid = $2 WHERE id = $1', [c.id, b.uid ? b.uid.toUpperCase() : null]);
    await audit(db, req.ctx, { action: 'CARD_RFID_LINK', targetType: 'card', targetId: c.id, targetLabel: c.card_number, oldData: { rfid: c.rfid_uid }, newData: { rfid: b.uid } });
  });
  res.json({ ok: true });
});

r.post('/cards/:id/portal-token/rotate', perm('card.print'), async (req, res) => {
  const token = await tx((db) => cards.ensurePortalToken(db, req.params.id, true));
  res.json({ portalUrl: `${config.publicUrl}/c/${token}` });
});

// ================================================================ LOYALTY
r.post('/cards/:id/stamps', async (req, res) => {
  const b = parse(z.object({ delta: z.number().int().refine((n) => n !== 0 && Math.abs(n) <= 1000), reason: z.string().max(300).optional(), machineId: zOptUuid, approval: z.any().optional() }), req.body);
  const permission = b.delta > 0 ? 'stamp.add' : 'stamp.remove';
  if (!req.ctx.staff.permissions.has(permission) && !req.ctx.staff.permissions.has('stamp.adjust')) throw fail('FORBIDDEN', undefined, { permission });
  if (b.delta < 0 && !b.reason) throw fail('VALIDATION_ERROR', 'Reason is required to remove stamps');
  const approverId = b.delta < 0 ? await requireApproval(req.ctx, 'stamp.remove', b.approval) : null;
  const out = await tx((db) => loyalty.changeStamps(db, req.ctx, { cardId: req.params.id, delta: b.delta, reason: b.reason || 'Stamp issued', approverId, machineId: b.machineId }));
  res.json({ txnNo: out.txn.txn_no, converted: !!out.converted, card: await cards.cardView({ query }, out.card) });
});

r.post('/cards/:id/points', async (req, res) => {
  const b = parse(z.object({ delta: z.number().int().refine((n) => n !== 0 && Math.abs(n) <= 1_000_000), reason: zReason, approval: z.any().optional() }), req.body);
  const permission = b.delta > 0 ? 'point.add' : 'point.remove';
  if (!req.ctx.staff.permissions.has(permission) && !req.ctx.staff.permissions.has('point.adjust')) throw fail('FORBIDDEN', undefined, { permission });
  const approverId = b.delta < 0 ? await requireApproval(req.ctx, 'point.remove', b.approval) : await requireApproval(req.ctx, 'point.add', b.approval);
  const out = await tx((db) => loyalty.changePoints(db, req.ctx, { cardId: req.params.id, delta: b.delta, reason: b.reason, approverId }));
  res.json({ txnNo: out.txn.txn_no, card: await cards.cardView({ query }, out.card) });
});

r.post('/cards/:id/convert-stamps', perm('stamp.convert'), async (req, res) => {
  const b = parse(z.object({ batches: z.number().int().min(1).optional() }), req.body);
  const out = await tx((db) => loyalty.convertStamps(db, req.ctx, { cardId: req.params.id, batches: b.batches, by: 'STAFF' }));
  res.json({ txnNo: out.txn.txn_no, card: await cards.cardView({ query }, out.card) });
});

export default r;
