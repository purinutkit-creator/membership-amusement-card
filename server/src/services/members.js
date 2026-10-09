import { one, many, afterCommit } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { memberCode } from '../lib/ids.js';
import { hashSecret } from '../lib/crypto.js';
import { getSettings } from './settings.js';
import { audit } from './audit.js';
import { emit } from '../realtime.js';
import { lockCard, postEntry } from './ledger.js';
import { evaluateTier } from './tiers.js';

const FIELDS = ['first_name', 'last_name', 'nickname', 'email', 'birthday', 'gender', 'address', 'note', 'language', 'home_branch_id'];
const camel = { first_name: 'firstName', last_name: 'lastName', home_branch_id: 'homeBranchId' };

export async function validateRegistrationFields(input, branchId) {
  const s = await getSettings(branchId);
  for (const [key, cfg] of Object.entries(s.member.fields || {})) {
    if (cfg.enabled && cfg.required && !input[key]) throw fail('VALIDATION_ERROR', `${key} is required`);
  }
  for (const cf of s.member.customFields || []) {
    if (cf.required && (input.customFields?.[cf.key] == null || input.customFields[cf.key] === '')) throw fail('VALIDATION_ERROR', `${cf.label || cf.key} is required`);
  }
}

export async function createMember(db, ctx, input) {
  await validateRegistrationFields(input, ctx.branchId);
  const dup = await one(db, `SELECT id FROM members WHERE phone = $1 AND status NOT IN ('MERGED','DELETED')`, [input.phone]);
  if (dup) throw fail('PHONE_EXISTS');
  const base = await one(db, `SELECT id FROM member_tiers WHERE status = 'ACTIVE' ORDER BY rank ASC LIMIT 1`);
  let m;
  try {
    m = await one(db,
      `INSERT INTO members(member_code, phone, first_name, last_name, nickname, email, birthday, gender, address, pin_hash, tier_id,
          custom_fields, note, language, home_branch_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [await memberCode(db), input.phone, input.firstName, input.lastName || '', input.nickname || null, input.email || null, input.birthday || null,
        input.gender || null, input.address || null, input.pin ? await hashSecret(input.pin) : null, base?.id || null,
        input.customFields || {}, input.note || null, input.language || null, ctx.branchId || null, ctx.staff?.id || null]);
  } catch (e) {
    if (e.code === '23505') throw fail('PHONE_EXISTS');
    throw e;
  }
  await audit(db, ctx, { action: 'MEMBER_CREATE', targetType: 'member', targetId: m.id, targetLabel: m.member_code, newData: { phone: m.phone, firstName: m.first_name, lastName: m.last_name } });
  afterCommit(db, () => emit(['staff'], 'member:new', { memberId: m.id }));
  return m;
}

export async function updateMember(db, ctx, id, input) {
  const before = await one(db, 'SELECT * FROM members WHERE id = $1 FOR UPDATE', [id]);
  if (!before) throw fail('MEMBER_NOT_FOUND');
  const sets = []; const vals = [id];
  for (const f of FIELDS) {
    const k = camel[f] || f;
    if (input[k] !== undefined) { vals.push(input[k] === '' ? null : input[k]); sets.push(`${f} = $${vals.length}`); }
  }
  if (input.phone && input.phone !== before.phone) {
    const dup = await one(db, `SELECT id FROM members WHERE phone = $1 AND id <> $2 AND status NOT IN ('MERGED','DELETED')`, [input.phone, id]);
    if (dup) throw fail('PHONE_EXISTS');
    vals.push(input.phone); sets.push(`phone = $${vals.length}`);
  }
  if (input.customFields) { vals.push({ ...before.custom_fields, ...input.customFields }); sets.push(`custom_fields = $${vals.length}`); }
  if (input.tierId !== undefined && ctx.staff) {
    vals.push(input.tierId); sets.push(`tier_id = $${vals.length}`);
    vals.push(input.tierLocked ?? true); sets.push(`tier_locked = $${vals.length}`);
  }
  if (!sets.length) return before;
  const after = await one(db, `UPDATE members SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, vals);
  const diff = (o) => Object.fromEntries(Object.keys(input).map((k) => [k, o[Object.keys(camel).find((x) => camel[x] === k) || k]]));
  await audit(db, ctx, { action: input.tierId !== undefined ? 'MEMBER_TIER_MANUAL' : 'MEMBER_EDIT', targetType: 'member', targetId: id, targetLabel: before.member_code, oldData: diff(before), newData: diff(after) });
  afterCommit(db, () => emit([`member:${id}`, 'staff'], 'member:update', { memberId: id }));
  return after;
}

export async function setMemberStatus(db, ctx, id, status, reason) {
  const m = await one(db, 'SELECT * FROM members WHERE id = $1 FOR UPDATE', [id]);
  if (!m) throw fail('MEMBER_NOT_FOUND');
  if (m.status === 'MERGED') throw fail('CONFLICT', 'Member was merged');
  await db.query('UPDATE members SET status = $2, block_reason = $3, updated_at = now() WHERE id = $1', [id, status, status === 'ACTIVE' ? null : reason]);
  if (status !== 'ACTIVE') await db.query(`UPDATE sessions SET revoked_at = now() WHERE subject_type = 'MEMBER' AND subject_id = $1 AND revoked_at IS NULL`, [id]);
  const action = { ACTIVE: 'MEMBER_ACTIVATE', SUSPENDED: 'MEMBER_SUSPEND', BLOCKED: 'MEMBER_BLOCK', DELETED: 'MEMBER_DELETE' }[status];
  await audit(db, ctx, { action, targetType: 'member', targetId: id, targetLabel: m.member_code, oldData: { status: m.status }, newData: { status }, reason });
}

export async function resetMemberPin(db, ctx, id, pin) {
  const m = await one(db, 'SELECT member_code FROM members WHERE id = $1', [id]);
  if (!m) throw fail('MEMBER_NOT_FOUND');
  await db.query('UPDATE members SET pin_hash = $2, failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [id, await hashSecret(pin)]);
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE subject_type = 'MEMBER' AND subject_id = $1 AND revoked_at IS NULL`, [id]);
  await audit(db, ctx, { action: 'MEMBER_RESET_PIN', targetType: 'member', targetId: id, targetLabel: m.member_code });
}

/**
 * Merge duplicate member `sourceId` into `targetId`: moves cards (with their balance/points/stamps),
 * history, redemptions, consents; sums lifetime counters; source becomes MERGED.
 */
export async function mergeMembers(db, ctx, { sourceId, targetId, reason, approverId }) {
  if (sourceId === targetId) throw fail('VALIDATION_ERROR', 'Choose two different members');
  const [a, b] = [sourceId, targetId].sort();
  await one(db, 'SELECT id FROM members WHERE id = $1 FOR UPDATE', [a]);
  await one(db, 'SELECT id FROM members WHERE id = $1 FOR UPDATE', [b]);
  const src = await one(db, 'SELECT * FROM members WHERE id = $1', [sourceId]);
  const dst = await one(db, 'SELECT * FROM members WHERE id = $1', [targetId]);
  if (!src || !dst) throw fail('MEMBER_NOT_FOUND');
  if (src.status === 'MERGED' || dst.status === 'MERGED') throw fail('CONFLICT', 'Member already merged');
  const cards = await many(db, 'SELECT id, card_number FROM cards WHERE member_id = $1', [sourceId]);
  for (const c of cards) {
    await db.query('UPDATE cards SET member_id = $2 WHERE id = $1', [c.id, targetId]);
    await db.query('UPDATE card_members SET unlinked_at = now() WHERE card_id = $1 AND unlinked_at IS NULL', [c.id]);
    await db.query('INSERT INTO card_members(card_id, member_id, linked_by, reason) VALUES ($1,$2,$3,$4)', [c.id, targetId, ctx.staff?.id || null, 'MERGE']);
  }
  await db.query(`UPDATE redemptions SET member_id = $2 WHERE member_id = $1`, [sourceId, targetId]);
  await db.query(`UPDATE notifications SET member_id = $2 WHERE member_id = $1`, [sourceId, targetId]);
  await db.query(`UPDATE privacy_consents SET member_id = $2 WHERE member_id = $1`, [sourceId, targetId]);
  // history (ledger rows stay immutable; they remain linked through the moved cards)
  await db.query(
    `UPDATE members SET total_spend = total_spend + $2, total_topup = total_topup + $3, total_play = total_play + $4, visit_count = visit_count + $5,
        lifetime_points = lifetime_points + $6, lifetime_stamps = lifetime_stamps + $7, updated_at = now() WHERE id = $1`,
    [targetId, src.total_spend, src.total_topup, src.total_play, src.visit_count, src.lifetime_points, src.lifetime_stamps]);
  await db.query(`UPDATE members SET status = 'MERGED', merged_into = $2, updated_at = now() WHERE id = $1`, [sourceId, targetId]);
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE subject_type = 'MEMBER' AND subject_id = $1`, [sourceId]);
  await evaluateTier(db, targetId, ctx);
  await audit(db, ctx, { action: 'MEMBER_MERGE', targetType: 'member', targetId, targetLabel: `${src.member_code} -> ${dst.member_code}`, oldData: { source: src.member_code, cards: cards.map((c) => c.card_number) }, newData: { target: dst.member_code }, reason, approverId });
  return { movedCards: cards.length };
}

export function memberView(m, extra = {}) {
  if (!m) return null;
  return {
    id: m.id, memberCode: m.member_code, phone: m.phone, firstName: m.first_name, lastName: m.last_name, nickname: m.nickname,
    email: m.email, birthday: m.birthday, gender: m.gender, address: m.address, joinDate: m.join_date, tierId: m.tier_id, tierLocked: m.tier_locked,
    totalSpend: Number(m.total_spend), totalTopup: Number(m.total_topup), totalPlay: m.total_play, visitCount: m.visit_count,
    lifetimePoints: m.lifetime_points, lifetimeStamps: m.lifetime_stamps, status: m.status, blockReason: m.block_reason,
    customFields: m.custom_fields, note: m.note, language: m.language, createdAt: m.created_at, hasPin: !!m.pin_hash, mergedInto: m.merged_into,
    ...extra,
  };
}

export async function memberSummary(db, memberId) {
  const m = await one(db, 'SELECT * FROM members WHERE id = $1', [memberId]);
  if (!m) throw fail('MEMBER_NOT_FOUND');
  const tier = m.tier_id ? await one(db, 'SELECT id, code, name, color, rank, benefits, card_theme, icon_media_id FROM member_tiers WHERE id = $1', [m.tier_id]) : null;
  const next = await one(db, `SELECT id, name, qualification FROM member_tiers WHERE status = 'ACTIVE' AND rank > coalesce($1, -1) ORDER BY rank LIMIT 1`, [tier?.rank ?? null]);
  const cards = await many(db, `SELECT * FROM cards WHERE member_id = $1 ORDER BY status = 'ACTIVE' DESC, issued_at DESC`, [memberId]);
  const active = cards.filter((c) => c.status === 'ACTIVE');
  return memberView(m, {
    tier, nextTier: next,
    balance: active.reduce((a, c) => a + Number(c.balance), 0),
    points: active.reduce((a, c) => a + c.points, 0),
    stamps: active.reduce((a, c) => a + c.stamps, 0),
    cards: cards.map((c) => ({ id: c.id, cardNumber: c.card_number, cardType: c.card_type, status: c.status, balance: Number(c.balance), points: c.points, stamps: c.stamps, expiresAt: c.expires_at, issuedAt: c.issued_at, lastUsedAt: c.last_used_at })),
  });
}

/** Birthday reward from tier benefits — grant once per year (called by daily job). */
export async function grantBirthdayRewards(db) {
  const rows = await many(db,
    `SELECT m.id, m.member_code, t.benefits FROM members m JOIN member_tiers t ON t.id = m.tier_id
      WHERE m.status = 'ACTIVE' AND m.birthday IS NOT NULL
        AND to_char(m.birthday, 'MM-DD') = to_char(now() AT TIME ZONE 'Asia/Bangkok', 'MM-DD')
        AND ((t.benefits->>'birthdayPoints')::int > 0 OR (t.benefits->>'birthdayStamps')::int > 0)
        AND NOT EXISTS (SELECT 1 FROM transactions x WHERE x.member_id = m.id AND x.reference = 'BIRTHDAY-' || to_char(now(), 'YYYY'))`);
  let n = 0;
  for (const r of rows) {
    const card = await one(db, `SELECT id FROM cards WHERE member_id = $1 AND status = 'ACTIVE' ORDER BY issued_at LIMIT 1`, [r.id]);
    if (!card) continue;
    const locked = await lockCard(db, card.id);
    await postEntry(db, locked, { type: 'PROMOTION_BONUS', points: Number(r.benefits.birthdayPoints || 0), stamps: Number(r.benefits.birthdayStamps || 0), reason: 'Happy birthday!', reference: `BIRTHDAY-${new Date().getFullYear()}` });
    n++;
  }
  return n;
}
