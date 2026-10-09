// Rewards & redemption. Member redeems in portal -> PENDING code (QR). Staff confirms at counter:
// points/stamps and stock are deducted atomically; a code can be confirmed only once.
import { one, many, afterCommit } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { randomCode } from '../lib/crypto.js';
import { lockCard, postEntry, reverseTransaction } from './ledger.js';
import { assertUsable } from './cards.js';
import { getSettings } from './settings.js';
import { audit } from './audit.js';
import { notify } from './notifications.js';
import { emit } from '../realtime.js';

export async function eligibility(db, reward, card, { branchId } = {}) {
  const reasons = [];
  const now = new Date();
  if (reward.status !== 'ACTIVE') reasons.push('INACTIVE');
  if (reward.start_at && new Date(reward.start_at) > now) reasons.push('NOT_STARTED');
  if (reward.end_at && new Date(reward.end_at) <= now) reasons.push('ENDED');
  if (reward.stock <= 0) reasons.push('OUT_OF_STOCK');
  if (reward.branch_ids?.length && branchId && !reward.branch_ids.includes(branchId)) reasons.push('BRANCH');
  if (reward.member_only && !card.member_id) reasons.push('MEMBER_ONLY');
  if (reward.tier_ids?.length) {
    const m = card.member_id ? await one(db, 'SELECT tier_id FROM members WHERE id = $1', [card.member_id]) : null;
    if (!m || !reward.tier_ids.includes(m.tier_id)) reasons.push('TIER');
  }
  if (card.points < reward.points_required) reasons.push('INSUFFICIENT_POINTS');
  if (card.stamps < reward.stamps_required) reasons.push('INSUFFICIENT_STAMPS');
  if (reward.limit_per_member && card.member_id) {
    const n = (await one(db, `SELECT count(*)::int AS n FROM redemptions WHERE reward_id = $1 AND member_id = $2 AND status IN ('PENDING','CONFIRMED')`, [reward.id, card.member_id])).n;
    if (n >= reward.limit_per_member) reasons.push('LIMIT_REACHED');
  }
  return { eligible: reasons.length === 0, reasons };
}

const REASON_ERR = { OUT_OF_STOCK: 'OUT_OF_STOCK', INSUFFICIENT_POINTS: 'INSUFFICIENT_POINTS', INSUFFICIENT_STAMPS: 'INSUFFICIENT_STAMPS' };
function throwFor(reasons) {
  const r = reasons[0];
  throw fail(REASON_ERR[r] || 'NOT_ELIGIBLE', REASON_ERR[r] ? undefined : `Not eligible: ${reasons.join(', ')}`, { reasons });
}

/** Member (or staff on behalf) creates a pending redemption code. Nothing is deducted yet. */
export async function requestRedemption(db, ctx, { rewardId, cardId, channel = 'PORTAL' }) {
  const s = await getSettings(ctx.branchId);
  const card = await lockCard(db, cardId);
  await assertUsable(db, card);
  if (ctx.member && card.member_id !== ctx.member.id) throw fail('CARD_MEMBER_MISMATCH');
  const reward = await one(db, 'SELECT * FROM rewards WHERE id = $1', [rewardId]);
  if (!reward) throw fail('NOT_FOUND', 'Reward not found');
  // points/stamps already reserved by other pending codes of this card
  const pending = await one(db, `SELECT coalesce(sum(points),0)::int AS p, coalesce(sum(stamps),0)::int AS s FROM redemptions WHERE card_id = $1 AND status = 'PENDING' AND (expires_at IS NULL OR expires_at > now())`, [card.id]);
  const avail = { ...card, points: card.points - pending.p, stamps: card.stamps - pending.s };
  const el = await eligibility(db, reward, avail, ctx);
  if (!el.eligible) throwFor(el.reasons);
  let code;
  for (let i = 0; i < 5; i++) {
    code = randomCode(8);
    if (!(await one(db, 'SELECT 1 FROM redemptions WHERE code = $1', [code]))) break;
  }
  const r = await one(db,
    `INSERT INTO redemptions(code, reward_id, member_id, card_id, points, stamps, channel, branch_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' hours')::interval) RETURNING *`,
    [code, reward.id, card.member_id, card.id, reward.points_required, reward.stamps_required, channel, ctx.branchId || null, String(s.reward.redemptionExpiryHours || 24)]);
  await audit(db, ctx, { action: 'REDEMPTION_REQUEST', targetType: 'redemption', targetId: r.id, targetLabel: code, newData: { reward: reward.name, cardId: card.id } });
  return { redemption: r, reward };
}

/** Counter confirms a code: re-validate, deduct points/stamps + stock, mark CONFIRMED (single use). */
export async function confirmRedemption(db, ctx, code) {
  const r = await one(db, 'SELECT * FROM redemptions WHERE code = $1 FOR UPDATE', [String(code).trim().toUpperCase()]);
  if (!r) throw fail('REDEMPTION_NOT_FOUND');
  if (r.status === 'CONFIRMED') throw fail('REDEMPTION_USED', `Code already used at ${new Date(r.confirmed_at).toLocaleString()}`);
  if (r.status !== 'PENDING') throw fail('REDEMPTION_USED', `Code is ${r.status}`);
  if (r.expires_at && new Date(r.expires_at) <= new Date()) {
    await db.query(`UPDATE redemptions SET status = 'EXPIRED' WHERE id = $1`, [r.id]);
    throw fail('REDEMPTION_EXPIRED');
  }
  const card = await lockCard(db, r.card_id);
  await assertUsable(db, card);
  const reward = await one(db, 'SELECT * FROM rewards WHERE id = $1 FOR UPDATE', [r.reward_id]);
  if (reward.stock < 1) throw fail('OUT_OF_STOCK');
  const { txn } = await postEntry(db, card, { type: 'REWARD_REDEMPTION', points: -r.points, stamps: -r.stamps, ctx, redemptionId: r.id, reference: r.code, reason: `Redeemed ${reward.name}` });
  await db.query('UPDATE rewards SET stock = stock - 1 WHERE id = $1', [reward.id]);
  await db.query(`INSERT INTO stock_movements(item_kind, reward_id, type, qty, stock_before, stock_after, reference, staff_id) VALUES ('REWARD',$1,'REDEEM',-1,$2,$3,$4,$5)`,
    [reward.id, reward.stock, reward.stock - 1, r.code, ctx.staff?.id || null]);
  const upd = await one(db, `UPDATE redemptions SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = $2, transaction_id = $3, branch_id = coalesce(branch_id, $4) WHERE id = $1 RETURNING *`,
    [r.id, ctx.staff?.id || null, txn.id, ctx.branchId || null]);
  if (reward.stock - 1 <= reward.low_stock_threshold) await notify(db, { audience: 'ALL_STAFF', type: 'LOW_STOCK', title: `Low reward stock: ${reward.name}`, body: `${reward.stock - 1} left`, data: { rewardId: reward.id } });
  if (card.member_id) await notify(db, { audience: 'MEMBER', memberId: card.member_id, type: 'REWARD_REDEEMED', title: `Redeemed: ${reward.name}`, data: { redemptionId: r.id } });
  await audit(db, ctx, { action: 'REWARD_REDEMPTION', targetType: 'redemption', targetId: r.id, targetLabel: r.code, newData: { reward: reward.name, points: r.points, stamps: r.stamps, txnNo: txn.txn_no } });
  afterCommit(db, () => emit([`card:${card.id}`, card.member_id && `member:${card.member_id}`, 'staff', `redemption:${r.id}`], 'redemption:update', { redemptionId: r.id, status: 'CONFIRMED', cardId: card.id }));
  return { redemption: upd, reward, txn, card };
}

export async function cancelRedemption(db, ctx, id, reason) {
  const r = await one(db, 'SELECT * FROM redemptions WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw fail('REDEMPTION_NOT_FOUND');
  if (ctx.member && r.member_id !== ctx.member.id) throw fail('FORBIDDEN');
  if (r.status === 'PENDING') {
    await db.query(`UPDATE redemptions SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1`, [r.id, ctx.staff?.id || null, reason]);
  } else if (r.status === 'CONFIRMED') {
    if (!ctx.staff) throw fail('FORBIDDEN');
    await reverseTransaction(db, r.transaction_id, { ctx, reason: `Cancel redemption ${r.code}: ${reason}` });
    const reward = await one(db, 'SELECT * FROM rewards WHERE id = $1 FOR UPDATE', [r.reward_id]);
    await db.query('UPDATE rewards SET stock = stock + 1 WHERE id = $1', [reward.id]);
    await db.query(`INSERT INTO stock_movements(item_kind, reward_id, type, qty, stock_before, stock_after, reference, reason, staff_id) VALUES ('REWARD',$1,'CANCEL',1,$2,$3,$4,$5,$6)`,
      [reward.id, reward.stock, reward.stock + 1, r.code, reason, ctx.staff.id]);
    await db.query(`UPDATE redemptions SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1`, [r.id, ctx.staff.id, reason]);
  } else throw fail('CONFLICT', `Redemption is ${r.status}`);
  await audit(db, ctx, { action: 'REDEMPTION_CANCEL', targetType: 'redemption', targetId: r.id, targetLabel: r.code, oldData: { status: r.status }, reason });
  afterCommit(db, () => emit([`card:${r.card_id}`, r.member_id && `member:${r.member_id}`, 'staff'], 'redemption:update', { redemptionId: r.id, status: 'CANCELLED' }));
}

/** Stock in / out / adjust for rewards or products with a movement record. */
export async function moveStock(db, ctx, { kind, id, type, qty, reason }) {
  const table = kind === 'REWARD' ? 'rewards' : 'products';
  const row = await one(db, `SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  if (!row) throw fail('NOT_FOUND');
  let after;
  if (type === 'IN') after = row.stock + Math.abs(qty);
  else if (type === 'OUT') after = row.stock - Math.abs(qty);
  else if (type === 'ADJUST') after = qty; // set absolute count
  else throw fail('VALIDATION_ERROR', 'Invalid movement type');
  if (after < 0) throw fail('OUT_OF_STOCK', 'Stock cannot go negative');
  await db.query(`UPDATE ${table} SET stock = $2 WHERE id = $1`, [id, after]);
  await db.query(`INSERT INTO stock_movements(item_kind, ${kind === 'REWARD' ? 'reward_id' : 'product_id'}, type, qty, stock_before, stock_after, reason, staff_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [kind, id, type, after - row.stock, row.stock, after, reason || null, ctx.staff?.id || null]);
  await audit(db, ctx, { action: `STOCK_${type}`, targetType: kind.toLowerCase(), targetId: id, targetLabel: row.name, oldData: { stock: row.stock }, newData: { stock: after }, reason });
  if (after <= row.low_stock_threshold) await notify(db, { audience: 'ALL_STAFF', type: 'LOW_STOCK', title: `Low stock: ${row.name}`, body: `${after} left`, data: { kind, id } });
  return { before: row.stock, after };
}

export async function listRewardsForCard(db, card, ctx) {
  const rows = await many(db, `SELECT * FROM rewards WHERE status = 'ACTIVE' ORDER BY points_required, stamps_required`);
  const out = [];
  for (const r of rows) out.push({ ...r, ...(card ? await eligibility(db, r, card, ctx) : { eligible: false, reasons: ['NO_CARD'] }) });
  return out;
}
