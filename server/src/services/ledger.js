// =====================================================================
// LEDGER — the only code path allowed to change card balance / points / stamps.
// Every change: lock card row -> validate -> update card -> insert immutable transaction.
// Must be called inside db.tx() with the card row locked (SELECT ... FOR UPDATE).
// =====================================================================
import { one } from '../db/pool.js';
import { dailyNo } from '../lib/ids.js';
import { fail } from '../lib/errors.js';
import { toSatang, fromSatang } from '../lib/money.js';

export async function lockCard(db, cardId) {
  const c = await one(db, 'SELECT * FROM cards WHERE id = $1 FOR UPDATE', [cardId]);
  if (!c) throw fail('CARD_NOT_FOUND');
  return c;
}

/** Lock several cards in a stable order to avoid deadlocks. */
export async function lockCards(db, ids) {
  const out = {};
  for (const id of [...new Set(ids)].sort()) out[id] = await lockCard(db, id);
  return out;
}

/**
 * Post one ledger entry against a LOCKED card row.
 * amount/bonus: signed baht delta to balance. points/stamps: signed integer deltas.
 * stats: optional counters to bump on the card ({ topup, spend, play, used, toppedUp }).
 */
export async function postEntry(db, card, e) {
  const amount = Number(e.amount || 0);
  const bonus = Number(e.bonus || 0);
  const points = Math.trunc(e.points || 0);
  const stamps = Math.trunc(e.stamps || 0);
  const balanceAfter = fromSatang(toSatang(card.balance) + toSatang(amount) + toSatang(bonus));
  const pointsAfter = card.points + points;
  const stampsAfter = card.stamps + stamps;
  if (balanceAfter < 0) throw fail('INSUFFICIENT_BALANCE', undefined, { required: -fromSatang(toSatang(amount) + toSatang(bonus)), balance: card.balance });
  if (pointsAfter < 0) throw fail('INSUFFICIENT_POINTS', undefined, { required: -points, points: card.points });
  if (stampsAfter < 0) throw fail('INSUFFICIENT_STAMPS', undefined, { required: -stamps, stamps: card.stamps });

  const st = e.stats || {};
  await db.query(`SELECT set_config('app.ledger_write', 'on', true)`);
  const updated = await one(db,
    `UPDATE cards SET balance = $2, points = $3, stamps = $4,
        total_topup = total_topup + $5, total_spend = total_spend + $6, total_play = total_play + $7,
        last_used_at = CASE WHEN $8 THEN now() ELSE last_used_at END,
        last_topup_at = CASE WHEN $9 THEN now() ELSE last_topup_at END
      WHERE id = $1 RETURNING *`,
    [card.id, balanceAfter, pointsAfter, stampsAfter, st.topup || 0, st.spend || 0, st.play || 0, !!st.used, !!st.toppedUp]);
  await db.query(`SELECT set_config('app.ledger_write', 'off', true)`);

  const ctx = e.ctx || {};
  const txnNo = await dailyNo(db, 'TXN');
  const txn = await one(db,
    `INSERT INTO transactions(txn_no, type, card_id, member_id, branch_id, device_id, staff_id, approver_id, machine_id, merchant_id,
        order_id, payment_id, topup_id, redemption_id, balance_before, amount, bonus, balance_after,
        points_before, points_delta, points_after, stamps_before, stamps_delta, stamps_after, cash_amount,
        reference, reason, reversal_of, promotions, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
     RETURNING *`,
    [txnNo, e.type, card.id, e.memberId !== undefined ? e.memberId : card.member_id, e.branchId || ctx.branchId || card.branch_id || null,
      ctx.device?.id || e.deviceId || null, ctx.staff?.id || null, e.approverId || null, e.machineId || null, e.merchantId || null,
      e.orderId || null, e.paymentId || null, e.topupId || null, e.redemptionId || null,
      card.balance, amount, bonus, balanceAfter, card.points, points, pointsAfter, card.stamps, stamps, stampsAfter,
      e.cashAmount || 0, e.reference || null, e.reason || null, e.reversalOf || null,
      JSON.stringify(e.promotions || []), JSON.stringify(e.meta || {})]);

  // keep the caller's locked row in sync for subsequent entries in the same tx
  Object.assign(card, updated);
  return { txn, card: updated };
}

/** Entry with no wallet effect (e.g. deposit taken in cash) — still ledgered for traceability. */
export const postInfoEntry = (db, card, e) => postEntry(db, card, { ...e, amount: 0, bonus: 0, points: 0, stamps: 0 });

const REVERSAL_TYPE = { TOP_UP: 'REFUND', PLAY: 'REFUND', FOOD_PURCHASE: 'REFUND', PURCHASE: 'REFUND', CARD_DEPOSIT: 'DEPOSIT_REFUND', REWARD_REDEMPTION: 'REDEMPTION_CANCEL' };

/**
 * Reverse a completed transaction by posting an opposite entry (never deletes).
 * Balance must be sufficient for the reversal; points/stamps earned but already spent
 * are clamped to what remains (recorded in meta.clamped).
 */
export async function reverseTransaction(db, txnId, { ctx, reason, approverId, cashAmount, orderId, paymentId }) {
  const orig = await one(db, 'SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [txnId]);
  if (!orig) throw fail('NOT_FOUND', 'Transaction not found');
  if (orig.reversed_by || orig.reversal_of) throw fail('ALREADY_REVERSED');
  const card = await lockCard(db, orig.card_id);
  let points = -orig.points_delta;
  let stamps = -orig.stamps_delta;
  const clamped = {};
  if (card.points + points < 0) { clamped.points = points; points = -card.points; }
  if (card.stamps + stamps < 0) { clamped.stamps = stamps; stamps = -card.stamps; }
  const stats = {};
  if (orig.type === 'TOP_UP') stats.topup = -Number(orig.amount);
  if (orig.type === 'PLAY') { stats.spend = Number(orig.amount); stats.play = -1; }
  if (orig.type === 'FOOD_PURCHASE' || orig.type === 'PURCHASE') stats.spend = Number(orig.amount);
  const { txn } = await postEntry(db, card, {
    type: REVERSAL_TYPE[orig.type] || 'REVERSAL',
    amount: -Number(orig.amount), bonus: -Number(orig.bonus), points, stamps,
    ctx, approverId, reason, reversalOf: orig.id, memberId: orig.member_id,
    machineId: orig.machine_id, merchantId: orig.merchant_id, orderId: orderId || orig.order_id, paymentId: paymentId || orig.payment_id,
    topupId: orig.topup_id, redemptionId: orig.redemption_id,
    cashAmount: cashAmount !== undefined ? cashAmount : -Number(orig.cash_amount || 0),
    reference: orig.txn_no, meta: { originalType: orig.type, clamped }, stats,
  });
  await db.query('UPDATE transactions SET reversed_by = $2 WHERE id = $1', [orig.id, txn.id]);
  return { original: orig, reversal: txn, card };
}

/** Reconcile a card: balance/points/stamps must equal the sum of its ledger deltas. */
export async function reconcileCard(db, cardId) {
  const r = await one(db,
    `SELECT c.balance, c.points, c.stamps,
            coalesce(sum(t.amount + t.bonus), 0)::numeric(14,2) AS ledger_balance,
            coalesce(sum(t.points_delta), 0)::int AS ledger_points,
            coalesce(sum(t.stamps_delta), 0)::int AS ledger_stamps
       FROM cards c LEFT JOIN transactions t ON t.card_id = c.id
      WHERE c.id = $1 GROUP BY c.id`, [cardId]);
  if (!r) throw fail('CARD_NOT_FOUND');
  return { ...r, ok: Number(r.balance) === Number(r.ledger_balance) && r.points === r.ledger_points && r.stamps === r.ledger_stamps };
}
