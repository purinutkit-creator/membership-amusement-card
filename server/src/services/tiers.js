import { one, many, afterCommit } from '../db/pool.js';
import { getSettings } from './settings.js';
import { notify } from './notifications.js';
import { audit } from './audit.js';
import { emit } from '../realtime.js';

export async function memberStats(db, memberId) {
  return one(db,
    `SELECT m.*, coalesce(sum(c.points) FILTER (WHERE c.status = 'ACTIVE'), 0)::int AS points_now,
            coalesce(sum(c.stamps) FILTER (WHERE c.status = 'ACTIVE'), 0)::int AS stamps_now
       FROM members m LEFT JOIN cards c ON c.member_id = m.id WHERE m.id = $1 GROUP BY m.id`, [memberId]);
}

export function qualifies(tier, m) {
  const q = tier.qualification || {};
  const checks = [];
  if (q.minPoints != null) checks.push(m.lifetime_points >= q.minPoints);
  if (q.minStamps != null) checks.push(m.lifetime_stamps >= q.minStamps);
  if (q.minSpend != null) checks.push(Number(m.total_spend) >= q.minSpend);
  if (q.minTopup != null) checks.push(Number(m.total_topup) >= q.minTopup);
  if (q.minVisits != null) checks.push(m.visit_count >= q.minVisits);
  if (q.minPlays != null) checks.push(m.total_play >= q.minPlays);
  if (!checks.length) return true; // base tier
  return q.mode === 'ALL' ? checks.every(Boolean) : checks.some(Boolean);
}

/** Recalculate a member's tier. Upgrades automatically; downgrades only if enabled. */
export async function evaluateTier(db, memberId, ctx) {
  const s = await getSettings();
  if (!s.general.modules.tiers || !s.tier.autoUpgrade) return null;
  const m = await one(db, 'SELECT m.*, t.rank AS tier_rank FROM members m LEFT JOIN member_tiers t ON t.id = m.tier_id WHERE m.id = $1 FOR UPDATE OF m', [memberId]);
  if (!m || m.tier_locked) return null;
  const tiers = await many(db, `SELECT * FROM member_tiers WHERE status = 'ACTIVE' ORDER BY rank DESC`);
  const best = tiers.find((t) => qualifies(t, m));
  if (!best || best.id === m.tier_id) return null;
  if (m.tier_rank != null && best.rank < m.tier_rank && !s.tier.allowDowngrade) return null;
  await db.query('UPDATE members SET tier_id = $2, updated_at = now() WHERE id = $1', [m.id, best.id]);
  const up = m.tier_rank == null || best.rank > m.tier_rank;
  await notify(db, { audience: 'MEMBER', memberId: m.id, type: 'TIER_UPGRADE', title: up ? `Tier upgraded to ${best.name}` : `Tier changed to ${best.name}`, data: { tierId: best.id } });
  if (up) await notify(db, { audience: 'ALL_STAFF', type: 'TIER_UPGRADE', title: `${m.first_name} upgraded to ${best.name}`, data: { memberId: m.id } });
  await audit(db, ctx, { action: 'TIER_CHANGE', targetType: 'member', targetId: m.id, targetLabel: m.member_code, oldData: { tierId: m.tier_id }, newData: { tierId: best.id, auto: true } });
  afterCommit(db, () => emit([`member:${m.id}`], 'member:update', { memberId: m.id }));
  return best;
}

export async function getMemberTier(db, memberId) {
  if (!memberId) return null;
  return one(db, 'SELECT t.* FROM members m JOIN member_tiers t ON t.id = m.tier_id WHERE m.id = $1', [memberId]);
}

/** Bump lifetime counters on the member and record a visit once per day. */
export async function bumpMemberStats(db, memberId, { spend = 0, topup = 0, play = 0, points = 0, stamps = 0 }) {
  if (!memberId) return;
  await db.query(
    `UPDATE members SET total_spend = total_spend + $2, total_topup = total_topup + $3, total_play = total_play + $4,
        lifetime_points = lifetime_points + GREATEST($5, 0), lifetime_stamps = lifetime_stamps + GREATEST($6, 0),
        visit_count = visit_count + CASE WHEN last_visit_date IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Bangkok')::date THEN 1 ELSE 0 END,
        last_visit_date = (now() AT TIME ZONE 'Asia/Bangkok')::date, updated_at = now()
      WHERE id = $1`, [memberId, spend, topup, play, points, stamps]);
}
