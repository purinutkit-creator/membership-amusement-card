// Stamps & points: manual add/remove/adjust and stamp->point conversion.
import { afterCommit, one } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { lockCard, postEntry } from './ledger.js';
import { assertUsable } from './cards.js';
import { getSettings } from './settings.js';
import { audit } from './audit.js';
import { bumpMemberStats, evaluateTier } from './tiers.js';
import { emit } from '../realtime.js';

function push(db, card) {
  afterCommit(db, () => emit(['staff', `card:${card.id}`, card.member_id && `member:${card.member_id}`], 'card:update', { cardId: card.id, balance: Number(card.balance), points: card.points, stamps: card.stamps }));
}

/** Add (+) or remove (-) stamps. */
export async function changeStamps(db, ctx, { cardId, delta, reason, approverId, machineId }) {
  if (!Number.isInteger(delta) || delta === 0) throw fail('VALIDATION_ERROR', 'Stamp quantity must be a non-zero integer');
  const s = await getSettings(ctx.branchId);
  const card = await lockCard(db, cardId);
  await assertUsable(db, card);
  if (delta > 0 && s.stamp.maxStamps > 0 && card.stamps + delta > s.stamp.maxStamps) throw fail('CONFLICT', `Maximum ${s.stamp.maxStamps} stamps per card`);
  const before = card.stamps;
  const { txn } = await postEntry(db, card, { type: delta > 0 ? 'STAMP_ADD' : 'STAMP_REMOVE', stamps: delta, ctx, reason, approverId, machineId });
  if (delta > 0) await bumpMemberStats(db, card.member_id, { stamps: delta });
  await audit(db, ctx, { action: delta > 0 ? 'STAMP_ADD' : 'STAMP_REMOVE', targetType: 'card', targetId: card.id, targetLabel: card.card_number, oldData: { stamps: before }, newData: { stamps: card.stamps, delta }, reason, approverId });
  const converted = delta > 0 ? await autoConvert(db, ctx, card) : null;
  if (card.member_id) await evaluateTier(db, card.member_id, ctx);
  push(db, card);
  return { txn, card, converted };
}

export async function changePoints(db, ctx, { cardId, delta, reason, approverId }) {
  if (!Number.isInteger(delta) || delta === 0) throw fail('VALIDATION_ERROR', 'Point quantity must be a non-zero integer');
  const card = await lockCard(db, cardId);
  await assertUsable(db, card);
  const before = card.points;
  const { txn } = await postEntry(db, card, { type: delta > 0 ? 'POINT_ADD' : 'POINT_REMOVE', points: delta, ctx, reason, approverId });
  if (delta > 0) await bumpMemberStats(db, card.member_id, { points: delta });
  await audit(db, ctx, { action: delta > 0 ? 'POINT_ADD' : 'POINT_REMOVE', targetType: 'card', targetId: card.id, targetLabel: card.card_number, oldData: { points: before }, newData: { points: card.points, delta }, reason, approverId });
  if (card.member_id) await evaluateTier(db, card.member_id, ctx);
  push(db, card);
  return { txn, card };
}

/** Manual balance adjustment (+/-) with mandatory reason & audit (old/adjust/new). */
export async function adjustBalance(db, ctx, { cardId, delta, reason, approverId }) {
  if (!delta) throw fail('VALIDATION_ERROR', 'Adjustment must be non-zero');
  const card = await lockCard(db, cardId);
  if (['REPLACED'].includes(card.status)) throw fail('CARD_REPLACED');
  const before = Number(card.balance);
  const { txn } = await postEntry(db, card, { type: 'BALANCE_ADJUSTMENT', amount: delta, ctx, reason, approverId });
  await audit(db, ctx, { action: 'BALANCE_ADJUSTMENT', targetType: 'card', targetId: card.id, targetLabel: card.card_number, oldData: { balance: before }, newData: { balance: Number(card.balance), adjustment: delta }, reason, approverId });
  push(db, card);
  return { txn, card };
}

/** Convert stamps to points in whole batches (e.g. 10 stamps -> 100 points). */
export async function convertStamps(db, ctx, { cardId, batches, by = 'STAFF' }) {
  const s = await getSettings(ctx.branchId);
  const conv = s.stamp.conversion;
  if (!conv?.enabled || !(conv.stamps > 0)) throw fail('FORBIDDEN', 'Stamp conversion is disabled');
  if (by === 'MEMBER' && !['MEMBER', 'AUTO'].includes(conv.mode) && conv.mode !== 'ANY') throw fail('FORBIDDEN', 'Members cannot convert stamps themselves');
  const card = await lockCard(db, cardId);
  await assertUsable(db, card);
  const max = Math.floor(card.stamps / conv.stamps);
  const n = batches == null ? max : Math.min(Number(batches), max);
  if (n < 1) throw fail('INSUFFICIENT_STAMPS', `Need at least ${conv.stamps} stamps`);
  const { txn } = await postEntry(db, card, {
    type: 'STAMP_CONVERT', stamps: -n * conv.stamps, points: n * conv.points, ctx,
    reason: `Convert ${n * conv.stamps} stamps -> ${n * conv.points} points`, meta: { batches: n, by },
  });
  await bumpMemberStats(db, card.member_id, { points: n * conv.points });
  push(db, card);
  return { txn, card };
}

/** AUTO conversion mode: convert whenever a full batch is reached. */
export async function autoConvert(db, ctx, card) {
  const s = await getSettings(ctx.branchId);
  const conv = s.stamp.conversion;
  if (!conv?.enabled || conv.mode !== 'AUTO' || !(conv.stamps > 0) || !card.member_id) return null;
  const n = Math.floor(card.stamps / conv.stamps);
  if (n < 1) return null;
  const { txn } = await postEntry(db, card, { type: 'STAMP_CONVERT', stamps: -n * conv.stamps, points: n * conv.points, ctx, reason: 'Automatic stamp conversion', meta: { batches: n, by: 'AUTO' } });
  await bumpMemberStats(db, card.member_id, { points: n * conv.points });
  return txn;
}

export async function loadCardForUpdate(db, cardId) { return one(db, 'SELECT * FROM cards WHERE id = $1', [cardId]); }
