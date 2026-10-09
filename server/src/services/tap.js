// =====================================================================
// CARD TAP — arcade / attraction play.
//  1 read card  2 status  3 expiry  4 machine  5 promotion  6 package  7 balance
//  8 price  9 deduct  10 points  11 stamps  12 ledger  13 allow play  14 respond
// Guarantees:
//  * request_id idempotency: a replayed request returns the stored result, never charges twice
//  * duplicate-tap cooldown per card+machine
//  * card row lock => concurrent taps on many machines can never overdraw
// =====================================================================
import { tx, one, query, afterCommit } from '../db/pool.js';
import { AppError, fail } from '../lib/errors.js';
import { lockCard, postEntry } from './ledger.js';
import { findCard, assertUsable } from './cards.js';
import { getSettings } from './settings.js';
import { evaluatePromotions, applyPriceEffects, rewardEffects, recordUsage } from './promotions.js';
import { computeEarn } from './earning.js';
import { bumpMemberStats, evaluateTier, getMemberTier } from './tiers.js';
import { autoConvert } from './loyalty.js';
import { notify } from './notifications.js';
import { allowPlay } from '../integrations/machine/index.js';
import { emit } from '../realtime.js';
import { localParts, inTimeWindow } from '../lib/time.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const mask = (n) => (n ? `********${String(n).slice(-4)}` : null);

/** Base price before promotions: lowest of fixed / member / tier / happy-hour price. */
export function machineBasePrice(machine, { memberId, tierId }, tz = 'Asia/Bangkok') {
  if (machine.free_play) return { price: 0, rule: 'FREE_PLAY' };
  const candidates = [{ price: Number(machine.price), rule: 'FIXED' }];
  if (memberId && machine.member_price != null) candidates.push({ price: Number(machine.member_price), rule: 'MEMBER' });
  if (tierId && machine.tier_prices?.[tierId] != null) candidates.push({ price: Number(machine.tier_prices[tierId]), rule: 'TIER' });
  const hh = machine.happy_hour || {};
  if (hh.enabled && hh.price != null) {
    const now = localParts(new Date(), tz);
    const dayOk = !hh.days?.length || hh.days.includes(now.dow);
    if (dayOk && inTimeWindow(now.minutes, hh.start, hh.end)) candidates.push({ price: Number(hh.price), rule: 'HAPPY_HOUR' });
  }
  return candidates.reduce((a, b) => (b.price < a.price ? b : a));
}

async function storeRejection({ requestId, device, machineId, cardId, code, status, response }) {
  await query(
    `INSERT INTO tap_requests(request_id, device_id, machine_id, card_id, result, http_status, response)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (request_id) DO NOTHING`,
    [requestId, device.id, machineId || null, cardId || null, code, status, response]).catch(() => {});
}

export async function processTap({ device, machineId, cardIdentifier, requestId, timestamp, ip }) {
  if (!requestId || requestId.length < 8 || requestId.length > 100) throw fail('VALIDATION_ERROR', 'requestId (8-100 chars) is required');
  const prior = await one({ query }, 'SELECT response, http_status FROM tap_requests WHERE request_id = $1', [requestId]);
  if (prior) return { status: prior.http_status, body: { ...prior.response, replayed: true } };

  if (timestamp && Math.abs(Date.now() - new Date(timestamp).getTime()) > 5 * 60000) {
    const body = { ok: false, result: 'STALE_REQUEST', message: 'Terminal clock is out of sync or request is too old' };
    return { status: 409, body };
  }

  let cardId = null;
  try {
    const out = await tx(async (db) => {
      // reserve the request id first: a concurrent duplicate blocks here and then replays
      await db.query(`INSERT INTO tap_requests(request_id, device_id, machine_id, result, http_status, response) VALUES ($1,$2,$3,'PROCESSING',0,'{}')`, [requestId, device.id, machineId]);

      // 4. machine
      const machine = await one(db, 'SELECT * FROM machines WHERE id = $1', [machineId]);
      if (!machine) throw fail('MACHINE_NOT_FOUND');
      if (machine.device_id && machine.device_id !== device.id) throw fail('FORBIDDEN', 'This terminal is not assigned to the machine');
      if (machine.branch_id && device.branch_id && machine.branch_id !== device.branch_id) throw fail('FORBIDDEN', 'Machine belongs to another branch');
      if (machine.status !== 'AVAILABLE') throw fail('MACHINE_UNAVAILABLE', `Machine is ${machine.status}`);
      const s = await getSettings(machine.branch_id);

      // 1-3. card + status + expiry (row lock serialises all taps of this card)
      const found = await findCard(db, cardIdentifier);
      cardId = found.id;
      const card = await lockCard(db, found.id);
      await assertUsable(db, card);

      // duplicate tap protection
      const cooldown = machine.cooldown_sec ?? s.card.tapCooldownSec ?? 3;
      if (cooldown > 0) {
        const recent = await one(db,
          `SELECT id FROM transactions WHERE card_id = $1 AND machine_id = $2 AND type = 'PLAY' AND reversed_by IS NULL
             AND created_at > now() - ($3 || ' seconds')::interval LIMIT 1`, [card.id, machine.id, String(cooldown)]);
        if (recent) throw fail('DUPLICATE_TAP', undefined, { cooldownSec: cooldown });
      }

      const member = card.member_id ? await one(db, 'SELECT id, first_name, birthday, tier_id FROM members WHERE id = $1', [card.member_id]) : null;
      const tier = await getMemberTier(db, card.member_id);
      const playsToday = (await one(db,
        `SELECT count(*)::int AS n FROM transactions WHERE card_id = $1 AND type = 'PLAY' AND reversed_by IS NULL
           AND created_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2`, [card.id, s.general.timezone])).n;

      // 5-8. pricing
      const base = machineBasePrice(machine, { memberId: card.member_id, tierId: tier?.id }, s.general.timezone);
      const promo = await evaluatePromotions(db, {
        appliesTo: 'PLAY', amount: base.price, memberId: card.member_id, cardId: card.id, tierId: tier?.id, birthday: member?.birthday,
        branchId: machine.branch_id, machineId: machine.id, categoryId: machine.category_id, playsToday: playsToday + 1,
      });
      const priced = applyPriceEffects(base.price, promo.applied);
      const effects = rewardEffects(priced.price, promo.applied);
      const price = priced.price;

      // 7. balance
      if (Number(card.balance) < price) {
        throw fail('INSUFFICIENT_BALANCE', undefined, { required: price, balance: Number(card.balance) });
      }

      // 10-11. earn
      const earn = await computeEarn(db, { event: 'PLAY', amount: price, card, tier, machine, settings: s, promo: effects });

      // 9 + 12. deduct and ledger (atomic with everything above)
      const used = [...priced.used, ...effects.used];
      const { txn } = await postEntry(db, card, {
        type: 'PLAY', amount: -price, points: earn.points, stamps: earn.stamps,
        ctx: { device }, branchId: machine.branch_id, machineId: machine.id,
        reference: requestId, promotions: used, meta: { priceRule: base.rule, basePrice: base.price, ip },
        stats: { spend: price, play: 1, used: true },
      });
      await bumpMemberStats(db, card.member_id, { spend: price, play: 1, points: earn.points, stamps: earn.stamps });
      if (used.length) await recordUsage(db, used, { memberId: card.member_id, cardId: card.id, transactionId: txn.id });
      const converted = await autoConvert(db, { device }, card);
      if (card.member_id) await evaluateTier(db, card.member_id, { device });
      await db.query('UPDATE machines SET last_seen_at = now(), online = true WHERE id = $1', [machine.id]);

      const lowBalance = Number(card.balance) < Number(s.wallet.lowBalanceThreshold || 0);
      if (lowBalance && card.member_id && s.notification.lowBalance) {
        await notify(db, { audience: 'MEMBER', memberId: card.member_id, type: 'LOW_BALANCE', title: 'Low balance', body: `Card ****${card.card_number.slice(-4)} balance is ฿${Number(card.balance).toFixed(2)}`, data: { cardId: card.id } });
      }

      const body = {
        ok: true, result: 'APPROVED', txnNo: txn.txn_no,
        machine: { id: machine.id, name: machine.name, code: machine.machine_code },
        card: { number: mask(card.card_number), type: card.card_type },
        member: member ? { firstName: member.first_name, tier: tier?.name || null } : null,
        amount: price, basePrice: base.price, priceRule: base.rule, promotions: used,
        balance: Number(card.balance), points: card.points, stamps: card.stamps,
        pointsEarned: earn.points, stampsEarned: earn.stamps, converted: !!converted, lowBalance,
        credits: machine.credits_per_play,
      };
      await db.query(`UPDATE tap_requests SET card_id = $2, result = 'APPROVED', http_status = 200, response = $3, transaction_id = $4 WHERE request_id = $1`,
        [requestId, card.id, body, txn.id]);

      // 13. allow play only after commit
      afterCommit(db, async () => {
        await allowPlay({ ...machine, config: device.config || {} }, { txnNo: txn.txn_no, cardId: card.id });
        emit(['staff', `card:${card.id}`, card.member_id && `member:${card.member_id}`], 'card:update', { cardId: card.id, balance: body.balance, points: body.points, stamps: body.stamps });
        emit(['staff'], 'txn:new', { type: 'PLAY', txnNo: txn.txn_no, amount: price, machineId: machine.id, branchId: machine.branch_id, at: txn.created_at });
      });
      return body;
    });
    return { status: 200, body: out };
  } catch (err) {
    if (err.code === '23505' && /tap_requests/.test(err.constraint || err.detail || '')) {
      // concurrent identical request: wait for the winner and replay its answer
      for (let i = 0; i < 20; i++) {
        const r = await one({ query }, 'SELECT response, http_status FROM tap_requests WHERE request_id = $1 AND result <> $2', [requestId, 'PROCESSING']);
        if (r) return { status: r.http_status, body: { ...r.response, replayed: true } };
        await new Promise((res) => setTimeout(res, 50));
      }
      return { status: 409, body: { ok: false, result: 'DUPLICATE_REQUEST', message: 'Request is being processed' } };
    }
    if (!(err instanceof AppError)) {
      logger.device.error('tap.error', { message: err.message, deviceId: device.id, machineId });
      throw err;
    }
    const body = { ok: false, result: err.code, message: err.message, ...(err.details || {}) };
    if (err.code === 'INSUFFICIENT_BALANCE') body.topupUrl = `${config.publicUrl}/m/topup`;
    await storeRejection({ requestId, device, machineId, cardId, code: err.code, status: err.status, response: body });
    if (cardId) emit(['staff'], 'tap:rejected', { machineId, result: err.code });
    return { status: err.status, body };
  }
}
