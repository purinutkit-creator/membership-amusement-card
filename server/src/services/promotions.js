// Rule-based promotion engine.
// A promotion = applies_to + rules (all must pass) + one effect. Selection policy:
//   PRIORITY : the highest-priority (lowest number) non-stackable wins; all stackables also apply
//   BEST     : the non-stackable with the largest benefit wins; all stackables also apply
//   STACK    : every eligible promotion applies
import { many, one } from '../db/pool.js';
import { localParts, inTimeWindow } from '../lib/time.js';
import { round2, pct } from '../lib/money.js';
import { getSettings } from './settings.js';

function ruleOk(rule, c) {
  const v = rule.value;
  switch (rule.rule_type) {
    case 'MEMBER_ONLY': return !!c.memberId;
    case 'TIER_IN': return !!c.tierId && v.includes(c.tierId);
    case 'MIN_AMOUNT': return Number(c.amount || 0) >= Number(v);
    case 'MIN_PLAYS_TODAY': return Number(c.playsToday || 0) >= Number(v);
    case 'DAYS_OF_WEEK': return v.includes(c.now.dow);
    case 'TIME_RANGE': return inTimeWindow(c.now.minutes, v.start, v.end);
    case 'BIRTHDAY_MONTH': return !!c.birthday && Number(String(c.birthday).slice(5, 7)) === c.now.month;
    case 'BRANCH_IN': return !!c.branchId && v.includes(c.branchId);
    case 'MACHINE_IN': return !!c.machineId && v.includes(c.machineId);
    case 'CATEGORY_IN': return !!c.categoryId && v.includes(c.categoryId);
    case 'MERCHANT_IN': return !!c.merchantId && v.includes(c.merchantId);
    case 'PACKAGE_IN': return !!c.packageId && v.includes(c.packageId);
    default: return false;
  }
}

/** Monetary value of a promotion for comparison under BEST policy. */
export function benefitOf(p, amount) {
  const v = Number(p.effect_value);
  let b = 0;
  switch (p.effect_type) {
    case 'BONUS_AMOUNT': case 'DISCOUNT_AMOUNT': b = v; break;
    case 'BONUS_PERCENT': case 'DISCOUNT_PERCENT': b = pct(amount, v); break;
    case 'FIXED_PRICE': b = Math.max(0, amount - v); break;
    case 'FREE_PLAY': b = amount; break;
    default: b = 0;
  }
  if (p.effect_type === 'DISCOUNT_AMOUNT' || p.effect_type === 'DISCOUNT_PERCENT') b = Math.min(b, amount);
  if (p.max_benefit != null) b = Math.min(b, Number(p.max_benefit));
  return round2(b);
}

/**
 * Find and select promotions for a context:
 * { appliesTo, amount, memberId, tierId, birthday, branchId, machineId, categoryId, merchantId, packageId, playsToday, cardId }
 */
export async function evaluatePromotions(db, c) {
  const s = await getSettings(c.branchId);
  if (!s.general.modules.promotions) return { applied: [], eligible: [] };
  const now = localParts(new Date(), s.general.timezone);
  const promos = await many(db,
    `SELECT p.*, coalesce(json_agg(r.*) FILTER (WHERE r.id IS NOT NULL), '[]') AS rules
       FROM promotions p LEFT JOIN promotion_rules r ON r.promotion_id = p.id
      WHERE p.status = 'ACTIVE' AND p.applies_to = $1
        AND (p.start_at IS NULL OR p.start_at <= now()) AND (p.end_at IS NULL OR p.end_at > now())
        AND (p.usage_limit IS NULL OR p.used_count < p.usage_limit)
      GROUP BY p.id ORDER BY p.priority ASC, p.created_at ASC`, [c.appliesTo]);
  const ctx = { ...c, now };
  const eligible = [];
  for (const p of promos) {
    if (!p.rules.every((r) => ruleOk(r, ctx))) continue;
    if (p.per_member_limit && (c.memberId || c.cardId)) {
      const used = await one(db, `SELECT count(*)::int AS n FROM promotion_usage WHERE promotion_id = $1 AND (member_id = $2 OR (member_id IS NULL AND card_id = $3))`, [p.id, c.memberId || null, c.cardId || null]);
      if (used.n >= p.per_member_limit) continue;
    }
    eligible.push({ ...p, benefit: benefitOf(p, Number(c.amount || 0)) });
  }
  const policy = s.promotion.policy || 'PRIORITY';
  let applied;
  if (policy === 'STACK') applied = eligible;
  else {
    const stackables = eligible.filter((p) => p.stackable);
    const exclusive = eligible.filter((p) => !p.stackable);
    let winner = null;
    if (exclusive.length) winner = policy === 'BEST' ? exclusive.reduce((a, b) => (b.benefit > a.benefit ? b : a)) : exclusive[0];
    applied = [...(winner ? [winner] : []), ...stackables];
  }
  return { applied, eligible, policy };
}

/** Apply PLAY / FOOD price effects in order: price-setting effects first, then discounts. */
export function applyPriceEffects(price, promos) {
  let p = Number(price);
  const order = ['FREE_PLAY', 'FIXED_PRICE', 'DISCOUNT_PERCENT', 'DISCOUNT_AMOUNT'];
  const used = [];
  for (const type of order) {
    for (const promo of promos.filter((x) => x.effect_type === type)) {
      const before = p;
      const v = Number(promo.effect_value);
      if (type === 'FREE_PLAY') p = 0;
      if (type === 'FIXED_PRICE') p = Math.min(p, v);
      if (type === 'DISCOUNT_PERCENT') { let d = pct(p, v); if (promo.max_benefit != null) d = Math.min(d, Number(promo.max_benefit)); p -= d; }
      if (type === 'DISCOUNT_AMOUNT') p -= v;
      p = Math.max(0, round2(p));
      used.push({ id: promo.id, name: promo.name, type, saved: round2(before - p) });
    }
  }
  return { price: p, used };
}

/** Sum non-price effects (bonus, points, stamps). */
export function rewardEffects(base, promos) {
  let bonus = 0, pointBonus = 0, stampBonus = 0, pointMult = 1, stampMult = 1;
  const used = [];
  for (const p of promos) {
    const v = Number(p.effect_value);
    let b = 0;
    if (p.effect_type === 'BONUS_AMOUNT') { b = v; }
    else if (p.effect_type === 'BONUS_PERCENT') { b = pct(base, v); }
    else if (p.effect_type === 'POINT_BONUS') { pointBonus += Math.trunc(v); used.push({ id: p.id, name: p.name, type: p.effect_type, points: Math.trunc(v) }); continue; }
    else if (p.effect_type === 'STAMP_BONUS') { stampBonus += Math.trunc(v); used.push({ id: p.id, name: p.name, type: p.effect_type, stamps: Math.trunc(v) }); continue; }
    else if (p.effect_type === 'POINT_MULTIPLIER') { pointMult *= v || 1; used.push({ id: p.id, name: p.name, type: p.effect_type, multiplier: v }); continue; }
    else if (p.effect_type === 'STAMP_MULTIPLIER') { stampMult *= v || 1; used.push({ id: p.id, name: p.name, type: p.effect_type, multiplier: v }); continue; }
    else continue;
    if (p.max_benefit != null) b = Math.min(b, Number(p.max_benefit));
    b = round2(b);
    bonus += b;
    used.push({ id: p.id, name: p.name, type: p.effect_type, bonus: b });
  }
  return { bonus: round2(bonus), pointBonus, stampBonus, pointMult, stampMult, used };
}

export async function recordUsage(db, used, { memberId, cardId, orderId, transactionId }) {
  for (const u of used) {
    await db.query(`INSERT INTO promotion_usage(promotion_id, member_id, card_id, order_id, transaction_id, benefit) VALUES ($1,$2,$3,$4,$5,$6)`,
      [u.id, memberId || null, cardId || null, orderId || null, transactionId || null, u.saved || u.bonus || 0]);
    await db.query('UPDATE promotions SET used_count = used_count + 1 WHERE id = $1', [u.id]);
  }
}
