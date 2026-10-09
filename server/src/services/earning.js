// Points & stamps earning rules shared by PLAY, FOOD and TOP_UP.
import { many } from '../db/pool.js';

export async function computeEarn(db, { event, amount, card, tier, machine, settings, promo }) {
  const s = settings;
  const benefits = tier?.benefits || {};
  promo = promo || { pointBonus: 0, stampBonus: 0, pointMult: 1, stampMult: 1 };
  let points = 0;
  if (s.general.modules.points && s.point.enabled && card.member_id) {
    const byAmount = s.point.earnAmount > 0 ? Math.floor(Number(amount) / s.point.earnAmount) * s.point.earnPoints : 0;
    if (event === 'PLAY') points = machine?.point_earn > 0 ? machine.point_earn : byAmount;
    else if (event === 'FOOD') points = byAmount;
    else if (event === 'TOP_UP') points = s.point.earnOnTopup ? byAmount : 0;
    if (s.point.tierMultiplier && benefits.pointMultiplier) points = points * Number(benefits.pointMultiplier);
    if (s.point.promotionMultiplier) points = points * promo.pointMult;
    points = Math.floor(points) + (promo.pointBonus || 0);
  }
  let stamps = 0;
  if (s.general.modules.stamps && s.stamp.enabled) {
    if (event === 'PLAY' && machine) stamps += machine.stamp_earn || 0;
    const rules = await many(db, `SELECT * FROM stamp_rules WHERE status = 'ACTIVE' AND event = $1`, [event]);
    for (const r of rules) {
      if (r.machine_id && r.machine_id !== machine?.id) continue;
      if (r.category_id && r.category_id !== machine?.category_id) continue;
      if (Number(amount) < Number(r.min_amount)) continue;
      stamps += r.per_amount ? Math.floor(Number(amount) / Number(r.per_amount)) * r.stamps : r.stamps;
    }
    if (s.stamp.tierMultiplier && benefits.stampMultiplier) stamps = stamps * Number(benefits.stampMultiplier);
    stamps = Math.floor(stamps * promo.stampMult) + (promo.stampBonus || 0);
    if (s.stamp.maxStamps > 0) stamps = Math.max(0, Math.min(stamps, s.stamp.maxStamps - card.stamps));
  }
  return { points: Math.max(0, points), stamps: Math.max(0, stamps) };
}
