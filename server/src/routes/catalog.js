// Machines, categories, tiers, promotions, stamp rules, rewards, redemptions, privacy policies.
import { Router } from 'express';
import { tx, one, many, query } from '../db/pool.js';
import { parse, z, zMoney, zOptUuid, zReason } from '../lib/validate.js';
import { fail } from '../lib/errors.js';
import { perm, permAny, requireStaff } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import * as rewards from '../services/rewards.js';
import { findCard, cardView } from '../services/cards.js';
import { paginate, where } from './_util.js';
import { emit } from '../realtime.js';

const r = Router();
r.use(requireStaff);

async function crudAudit(db, ctx, action, type, row, old) {
  await audit(db, ctx, { action, targetType: type, targetId: row.id, targetLabel: row.name || row.code || row.machine_code, oldData: old, newData: row });
}

// ================================================================ machine categories
r.get('/machine-categories', permAny('machine.view', 'promotion.view'), async (_req, res) => res.json({ items: await many({ query }, 'SELECT * FROM machine_categories ORDER BY sort, name') }));
const catSchema = z.object({ code: z.string().trim().min(1).max(30), name: z.string().trim().min(1).max(60), icon: z.string().max(40).optional(), sort: z.number().int().default(0) });
r.post('/machine-categories', perm('machine.manage'), async (req, res) => {
  const b = parse(catSchema, req.body);
  res.status(201).json(await tx(async (db) => { const x = await one(db, 'INSERT INTO machine_categories(code, name, icon, sort) VALUES ($1,$2,$3,$4) RETURNING *', [b.code.toUpperCase(), b.name, b.icon || null, b.sort]); await crudAudit(db, req.ctx, 'CATEGORY_CREATE', 'machine_category', x); return x; }));
});
r.put('/machine-categories/:id', perm('machine.manage'), async (req, res) => {
  const b = parse(catSchema, req.body);
  res.json(await tx(async (db) => { const x = await one(db, 'UPDATE machine_categories SET code=$2, name=$3, icon=$4, sort=$5 WHERE id=$1 RETURNING *', [req.params.id, b.code.toUpperCase(), b.name, b.icon || null, b.sort]); if (!x) throw fail('NOT_FOUND'); await crudAudit(db, req.ctx, 'CATEGORY_EDIT', 'machine_category', x); return x; }));
});
r.delete('/machine-categories/:id', perm('machine.manage'), async (req, res) => {
  const used = await one({ query }, 'SELECT 1 FROM machines WHERE category_id = $1 LIMIT 1', [req.params.id]);
  if (used) throw fail('CONFLICT', 'Category is used by machines');
  await query('DELETE FROM machine_categories WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ================================================================ machines
r.get('/machines', permAny('machine.view', 'stamp.add', 'promotion.view'), async (req, res) => {
  const w = where();
  if (req.query.status) w.add('m.status = $?', req.query.status);
  if (req.query.online) w.add('m.online = $?', req.query.online === '1');
  if (req.query.categoryId) w.add('m.category_id = $?', req.query.categoryId);
  if (req.query.branchId) w.add('m.branch_id = $?', req.query.branchId);
  if (req.query.zone) w.add('m.zone = $?', req.query.zone);
  if (req.query.q) w.add('(m.name ILIKE $? OR m.machine_code ILIKE $?)', `%${req.query.q}%`, `%${req.query.q}%`);
  res.json(await paginate(`SELECT m.*, c.name AS category_name, b.name AS branch_name, d.device_code, d.name AS device_name, d.online AS device_online,
      (SELECT count(*)::int FROM transactions t WHERE t.machine_id = m.id AND t.type = 'PLAY' AND t.reversed_by IS NULL AND t.created_at >= date_trunc('day', now())) AS plays_today,
      (SELECT coalesce(-sum(t.amount),0) FROM transactions t WHERE t.machine_id = m.id AND t.type = 'PLAY' AND t.reversed_by IS NULL AND t.created_at >= date_trunc('day', now())) AS revenue_today
    FROM machines m LEFT JOIN machine_categories c ON c.id = m.category_id LEFT JOIN branches b ON b.id = m.branch_id LEFT JOIN devices d ON d.id = m.device_id ${w.sql()}`, w.params, { pageSize: 100, ...req.query }, 'm.zone NULLS LAST, m.name'));
});
r.get('/machines/:id', permAny('machine.view'), async (req, res) => {
  const m = await one({ query }, `SELECT m.*, c.name AS category_name, d.device_code, d.name AS device_name FROM machines m LEFT JOIN machine_categories c ON c.id = m.category_id LEFT JOIN devices d ON d.id = m.device_id WHERE m.id = $1`, [req.params.id]);
  if (!m) throw fail('MACHINE_NOT_FOUND');
  res.json(m);
});
const machineSchema = z.object({
  machineCode: z.string().trim().min(1).max(30), name: z.string().trim().min(1).max(100), imageMediaId: zOptUuid, categoryId: zOptUuid, branchId: zOptUuid,
  zone: z.string().max(40).optional(), location: z.string().max(100).optional(), price: zMoney, memberPrice: zMoney.nullable().optional(),
  tierPrices: z.record(z.coerce.number().min(0)).default({}), happyHour: z.object({ enabled: z.boolean(), days: z.array(z.number().int().min(0).max(6)).default([]), start: z.string().optional(), end: z.string().optional(), price: z.number().min(0).optional() }).default({ enabled: false }),
  freePlay: z.boolean().default(false), pointEarn: z.number().int().min(0).default(0), stampEarn: z.number().int().min(0).default(0), creditsPerPlay: z.number().int().min(1).max(50).default(1),
  cooldownSec: z.number().int().min(0).max(300).nullable().optional(), status: z.enum(['AVAILABLE', 'MAINTENANCE', 'DISABLED', 'ERROR']).default('AVAILABLE'), deviceId: zOptUuid, note: z.string().max(500).optional(),
});
const mVals = (b) => [b.machineCode.toUpperCase(), b.name, b.imageMediaId || null, b.categoryId || null, b.branchId || null, b.zone || null, b.location || null, b.price, b.memberPrice ?? null,
  b.tierPrices, b.happyHour, b.freePlay, b.pointEarn, b.stampEarn, b.creditsPerPlay, b.cooldownSec ?? null, b.status, b.deviceId || null, b.note || null];
r.post('/machines', perm('machine.manage'), async (req, res) => {
  const b = parse(machineSchema, req.body);
  res.status(201).json(await tx(async (db) => {
    const x = await one(db, `INSERT INTO machines(machine_code, name, image_media_id, category_id, branch_id, zone, location, price, member_price, tier_prices, happy_hour, free_play, point_earn, stamp_earn, credits_per_play, cooldown_sec, status, device_id, note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`, mVals(b));
    await crudAudit(db, req.ctx, 'MACHINE_CREATE', 'machine', x);
    return x;
  }));
});
r.put('/machines/:id', perm('machine.manage'), async (req, res) => {
  const b = parse(machineSchema, req.body);
  res.json(await tx(async (db) => {
    const old = await one(db, 'SELECT * FROM machines WHERE id = $1', [req.params.id]);
    if (!old) throw fail('MACHINE_NOT_FOUND');
    const x = await one(db, `UPDATE machines SET machine_code=$1, name=$2, image_media_id=$3, category_id=$4, branch_id=$5, zone=$6, location=$7, price=$8, member_price=$9, tier_prices=$10,
      happy_hour=$11, free_play=$12, point_earn=$13, stamp_earn=$14, credits_per_play=$15, cooldown_sec=$16, status=$17, device_id=$18, note=$19 WHERE id = $20 RETURNING *`, [...mVals(b), old.id]);
    await crudAudit(db, req.ctx, 'MACHINE_EDIT', 'machine', x, old);
    db.afterCommit(() => emit(['staff', `machine:${x.id}`], 'machine:update', { machineId: x.id, status: x.status }));
    return x;
  }));
});
r.post('/machines/:id/status', permAny('machine.manage', 'machine.view'), async (req, res) => {
  const b = parse(z.object({ status: z.enum(['AVAILABLE', 'MAINTENANCE', 'DISABLED', 'ERROR']), note: z.string().max(300).optional() }), req.body);
  if (!req.ctx.staff.permissions.has('machine.manage') && !['MAINTENANCE', 'ERROR', 'AVAILABLE'].includes(b.status)) throw fail('FORBIDDEN');
  res.json(await tx(async (db) => {
    const old = await one(db, 'SELECT * FROM machines WHERE id = $1', [req.params.id]);
    if (!old) throw fail('MACHINE_NOT_FOUND');
    const x = await one(db, 'UPDATE machines SET status = $2, note = coalesce($3, note) WHERE id = $1 RETURNING *', [old.id, b.status, b.note || null]);
    await audit(db, req.ctx, { action: 'MACHINE_STATUS', targetType: 'machine', targetId: x.id, targetLabel: x.machine_code, oldData: { status: old.status }, newData: { status: x.status }, reason: b.note });
    db.afterCommit(() => emit(['staff', `machine:${x.id}`], 'machine:update', { machineId: x.id, status: x.status }));
    return x;
  }));
});
r.delete('/machines/:id', perm('machine.manage'), async (req, res) => {
  await tx(async (db) => {
    const old = await one(db, 'SELECT * FROM machines WHERE id = $1', [req.params.id]);
    if (!old) throw fail('MACHINE_NOT_FOUND');
    const used = await one(db, 'SELECT 1 FROM transactions WHERE machine_id = $1 LIMIT 1', [old.id]);
    if (used) await db.query(`UPDATE machines SET status = 'DISABLED' WHERE id = $1`, [old.id]);
    else await db.query('DELETE FROM machines WHERE id = $1', [old.id]);
    await audit(db, req.ctx, { action: used ? 'MACHINE_DISABLE' : 'MACHINE_DELETE', targetType: 'machine', targetId: old.id, targetLabel: old.machine_code });
  });
  res.json({ ok: true });
});

// ================================================================ tiers
r.get('/tiers', async (_req, res) => res.json({ items: await many({ query }, `SELECT t.*, (SELECT count(*)::int FROM members m WHERE m.tier_id = t.id AND m.status = 'ACTIVE') AS member_count FROM member_tiers t ORDER BY rank`) }));
const tierSchema = z.object({
  code: z.string().trim().min(1).max(30), name: z.string().trim().min(1).max(60), rank: z.number().int().min(0).max(1000), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), iconMediaId: zOptUuid,
  cardTheme: z.record(z.any()).default({}),
  qualification: z.object({ mode: z.enum(['ANY', 'ALL']).default('ANY'), minPoints: z.number().nullable().optional(), minStamps: z.number().nullable().optional(), minSpend: z.number().nullable().optional(), minTopup: z.number().nullable().optional(), minVisits: z.number().nullable().optional(), minPlays: z.number().nullable().optional() }).default({ mode: 'ANY' }),
  benefits: z.object({ topupBonusPct: z.number().min(0).max(100).optional(), discountPct: z.number().min(0).max(100).optional(), pointMultiplier: z.number().min(0).max(10).optional(), stampMultiplier: z.number().min(0).max(10).optional(), birthdayPoints: z.number().int().min(0).optional(), birthdayStamps: z.number().int().min(0).optional(), description: z.string().max(500).optional() }).default({}),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});
const clean = (q) => Object.fromEntries(Object.entries(q).filter(([, v]) => v !== null && v !== undefined && v !== ''));
r.post('/tiers', perm('settings.edit'), async (req, res) => {
  const b = parse(tierSchema, req.body);
  res.status(201).json(await tx(async (db) => { const x = await one(db, 'INSERT INTO member_tiers(code, name, rank, color, icon_media_id, card_theme, qualification, benefits, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [b.code.toUpperCase(), b.name, b.rank, b.color, b.iconMediaId || null, b.cardTheme, clean(b.qualification), b.benefits, b.status]); await crudAudit(db, req.ctx, 'TIER_CREATE', 'tier', x); return x; }));
});
r.put('/tiers/:id', perm('settings.edit'), async (req, res) => {
  const b = parse(tierSchema, req.body);
  res.json(await tx(async (db) => {
    const old = await one(db, 'SELECT * FROM member_tiers WHERE id = $1', [req.params.id]);
    if (!old) throw fail('NOT_FOUND');
    const x = await one(db, 'UPDATE member_tiers SET code=$2, name=$3, rank=$4, color=$5, icon_media_id=$6, card_theme=$7, qualification=$8, benefits=$9, status=$10 WHERE id=$1 RETURNING *', [old.id, b.code.toUpperCase(), b.name, b.rank, b.color, b.iconMediaId || null, b.cardTheme, clean(b.qualification), b.benefits, b.status]);
    await crudAudit(db, req.ctx, 'TIER_EDIT', 'tier', x, old);
    return x;
  }));
});
r.delete('/tiers/:id', perm('settings.edit'), async (req, res) => {
  const used = await one({ query }, 'SELECT 1 FROM members WHERE tier_id = $1 LIMIT 1', [req.params.id]);
  if (used) throw fail('CONFLICT', 'Tier has members — deactivate it instead');
  await tx(async (db) => { await db.query('DELETE FROM member_tiers WHERE id = $1', [req.params.id]); await audit(db, req.ctx, { action: 'TIER_DELETE', targetType: 'tier', targetId: req.params.id }); });
  res.json({ ok: true });
});
r.post('/tiers/recalculate', perm('settings.edit'), async (req, res) => {
  const { evaluateTier } = await import('../services/tiers.js');
  const ids = await many({ query }, `SELECT id FROM members WHERE status = 'ACTIVE' AND NOT tier_locked`);
  let changed = 0;
  for (const m of ids) if (await tx((db) => evaluateTier(db, m.id, req.ctx))) changed++;
  res.json({ checked: ids.length, changed });
});

// ================================================================ promotions
r.get('/promotions', permAny('promotion.view', 'promotion.manage'), async (req, res) => {
  const w = where();
  if (req.query.status) w.add('p.status = $?', req.query.status);
  if (req.query.appliesTo) w.add('p.applies_to = $?', req.query.appliesTo);
  if (req.query.q) w.add('(p.name ILIKE $? OR p.code ILIKE $?)', `%${req.query.q}%`, `%${req.query.q}%`);
  res.json(await paginate(`SELECT p.*, coalesce((SELECT json_agg(json_build_object('type', r.rule_type, 'value', r.value)) FROM promotion_rules r WHERE r.promotion_id = p.id), '[]') AS rules,
    (SELECT coalesce(sum(benefit),0) FROM promotion_usage u WHERE u.promotion_id = p.id) AS total_benefit FROM promotions p ${w.sql()}`, w.params, req.query, 'p.status, p.priority, p.created_at DESC'));
});
const promoSchema = z.object({
  code: z.string().max(30).optional().or(z.literal('')), name: z.string().trim().min(1).max(120), description: z.string().max(1000).optional(),
  appliesTo: z.enum(['TOP_UP', 'PLAY', 'FOOD', 'REWARD']), effectType: z.enum(['BONUS_AMOUNT', 'BONUS_PERCENT', 'DISCOUNT_AMOUNT', 'DISCOUNT_PERCENT', 'FIXED_PRICE', 'FREE_PLAY', 'POINT_MULTIPLIER', 'POINT_BONUS', 'STAMP_BONUS', 'STAMP_MULTIPLIER']),
  effectValue: z.number().min(0).max(1_000_000), maxBenefit: z.number().min(0).nullable().optional(), stackable: z.boolean().default(false), priority: z.number().int().min(0).max(10000).default(100),
  startAt: z.string().nullable().optional(), endAt: z.string().nullable().optional(), usageLimit: z.number().int().min(1).nullable().optional(), perMemberLimit: z.number().int().min(1).nullable().optional(),
  mediaId: zOptUuid, status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']).default('DRAFT'),
  rules: z.array(z.object({ type: z.enum(['MEMBER_ONLY', 'TIER_IN', 'MIN_AMOUNT', 'MIN_PLAYS_TODAY', 'DAYS_OF_WEEK', 'TIME_RANGE', 'BIRTHDAY_MONTH', 'BRANCH_IN', 'MACHINE_IN', 'CATEGORY_IN', 'MERCHANT_IN', 'PACKAGE_IN']), value: z.any() })).default([]),
});
const VALID_EFFECTS = {
  TOP_UP: ['BONUS_AMOUNT', 'BONUS_PERCENT', 'POINT_BONUS', 'STAMP_BONUS'],
  PLAY: ['DISCOUNT_AMOUNT', 'DISCOUNT_PERCENT', 'FIXED_PRICE', 'FREE_PLAY', 'POINT_MULTIPLIER', 'POINT_BONUS', 'STAMP_BONUS', 'STAMP_MULTIPLIER'],
  FOOD: ['DISCOUNT_AMOUNT', 'DISCOUNT_PERCENT', 'POINT_MULTIPLIER', 'POINT_BONUS', 'STAMP_BONUS', 'STAMP_MULTIPLIER'],
  REWARD: ['DISCOUNT_PERCENT'],
};
function normRule(rule) {
  const v = rule.value;
  switch (rule.type) {
    case 'MEMBER_ONLY': case 'BIRTHDAY_MONTH': return true;
    case 'MIN_AMOUNT': case 'MIN_PLAYS_TODAY': if (!(Number(v) >= 0)) throw fail('VALIDATION_ERROR', `${rule.type} needs a number`); return Number(v);
    case 'DAYS_OF_WEEK': if (!Array.isArray(v) || !v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw fail('VALIDATION_ERROR', 'Days must be 0-6'); return v;
    case 'TIME_RANGE': if (!/^\d{2}:\d{2}$/.test(v?.start) || !/^\d{2}:\d{2}$/.test(v?.end)) throw fail('VALIDATION_ERROR', 'Time range needs start/end HH:MM'); return { start: v.start, end: v.end };
    default: if (!Array.isArray(v) || !v.length) throw fail('VALIDATION_ERROR', `${rule.type} needs at least one value`); return v;
  }
}
async function savePromotion(db, ctx, b, id) {
  if (!VALID_EFFECTS[b.appliesTo].includes(b.effectType)) throw fail('VALIDATION_ERROR', `${b.effectType} is not valid for ${b.appliesTo}`);
  const rules = b.rules.map((x) => ({ type: x.type, value: normRule(x) }));
  const vals = [b.code || null, b.name, b.description || null, b.appliesTo, b.effectType, b.effectValue, b.maxBenefit ?? null, b.stackable, b.priority, b.startAt || null, b.endAt || null, b.usageLimit ?? null, b.perMemberLimit ?? null, b.mediaId || null, b.status];
  let x;
  if (id) {
    x = await one(db, `UPDATE promotions SET code=$1, name=$2, description=$3, applies_to=$4, effect_type=$5, effect_value=$6, max_benefit=$7, stackable=$8, priority=$9, start_at=$10, end_at=$11,
      usage_limit=$12, per_member_limit=$13, media_id=$14, status=$15, updated_at = now() WHERE id = $16 RETURNING *`, [...vals, id]);
    if (!x) throw fail('NOT_FOUND');
    await db.query('DELETE FROM promotion_rules WHERE promotion_id = $1', [id]);
  } else {
    x = await one(db, `INSERT INTO promotions(code, name, description, applies_to, effect_type, effect_value, max_benefit, stackable, priority, start_at, end_at, usage_limit, per_member_limit, media_id, status, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`, [...vals, ctx.staff.id]);
  }
  for (const rule of rules) await db.query('INSERT INTO promotion_rules(promotion_id, rule_type, value) VALUES ($1,$2,$3)', [x.id, rule.type, JSON.stringify(rule.value)]);
  return { ...x, rules };
}
r.post('/promotions', perm('promotion.manage'), async (req, res) => {
  const b = parse(promoSchema, req.body);
  res.status(201).json(await tx(async (db) => { const x = await savePromotion(db, req.ctx, b); await audit(db, req.ctx, { action: 'PROMOTION_CREATE', targetType: 'promotion', targetId: x.id, targetLabel: x.name, newData: x }); return x; }));
});
r.put('/promotions/:id', perm('promotion.manage'), async (req, res) => {
  const b = parse(promoSchema, req.body);
  res.json(await tx(async (db) => {
    const old = await one(db, 'SELECT * FROM promotions WHERE id = $1', [req.params.id]);
    const x = await savePromotion(db, req.ctx, b, req.params.id);
    await audit(db, req.ctx, { action: 'PROMOTION_CHANGE', targetType: 'promotion', targetId: x.id, targetLabel: x.name, oldData: old, newData: x });
    return x;
  }));
});
r.post('/promotions/:id/status', perm('promotion.manage'), async (req, res) => {
  const b = parse(z.object({ status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']) }), req.body);
  res.json(await tx(async (db) => {
    const x = await one(db, 'UPDATE promotions SET status = $2, updated_at = now() WHERE id = $1 RETURNING *', [req.params.id, b.status]);
    if (!x) throw fail('NOT_FOUND');
    await audit(db, req.ctx, { action: 'PROMOTION_CHANGE', targetType: 'promotion', targetId: x.id, targetLabel: x.name, newData: { status: b.status } });
    return x;
  }));
});
r.delete('/promotions/:id', perm('promotion.manage'), async (req, res) => {
  await tx(async (db) => {
    const used = await one(db, 'SELECT 1 FROM promotion_usage WHERE promotion_id = $1 LIMIT 1', [req.params.id]);
    if (used) await db.query(`UPDATE promotions SET status = 'INACTIVE' WHERE id = $1`, [req.params.id]);
    else await db.query('DELETE FROM promotions WHERE id = $1', [req.params.id]);
    await audit(db, req.ctx, { action: 'PROMOTION_DELETE', targetType: 'promotion', targetId: req.params.id });
  });
  res.json({ ok: true });
});

// ================================================================ stamp rules
r.get('/stamp-rules', permAny('promotion.view', 'settings.view'), async (_req, res) => res.json({ items: await many({ query }, 'SELECT s.*, m.name AS machine_name, c.name AS category_name FROM stamp_rules s LEFT JOIN machines m ON m.id = s.machine_id LEFT JOIN machine_categories c ON c.id = s.category_id ORDER BY s.event, s.created_at') }));
const srSchema = z.object({ name: z.string().trim().min(1).max(100), event: z.enum(['PLAY', 'FOOD', 'TOP_UP']), machineId: zOptUuid, categoryId: zOptUuid, minAmount: zMoney.default(0), perAmount: zMoney.nullable().optional(), stamps: z.number().int().min(1).max(1000), status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE') });
r.post('/stamp-rules', perm('settings.edit'), async (req, res) => {
  const b = parse(srSchema, req.body);
  res.status(201).json(await tx(async (db) => { const x = await one(db, 'INSERT INTO stamp_rules(name, event, machine_id, category_id, min_amount, per_amount, stamps, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [b.name, b.event, b.machineId || null, b.categoryId || null, b.minAmount, b.perAmount || null, b.stamps, b.status]); await crudAudit(db, req.ctx, 'STAMP_RULE_CREATE', 'stamp_rule', x); return x; }));
});
r.put('/stamp-rules/:id', perm('settings.edit'), async (req, res) => {
  const b = parse(srSchema, req.body);
  res.json(await tx(async (db) => { const x = await one(db, 'UPDATE stamp_rules SET name=$2, event=$3, machine_id=$4, category_id=$5, min_amount=$6, per_amount=$7, stamps=$8, status=$9 WHERE id=$1 RETURNING *', [req.params.id, b.name, b.event, b.machineId || null, b.categoryId || null, b.minAmount, b.perAmount || null, b.stamps, b.status]); if (!x) throw fail('NOT_FOUND'); await crudAudit(db, req.ctx, 'STAMP_RULE_EDIT', 'stamp_rule', x); return x; }));
});
r.delete('/stamp-rules/:id', perm('settings.edit'), async (req, res) => { await tx(async (db) => { await db.query('DELETE FROM stamp_rules WHERE id = $1', [req.params.id]); await audit(db, req.ctx, { action: 'STAMP_RULE_DELETE', targetType: 'stamp_rule', targetId: req.params.id }); }); res.json({ ok: true }); });

// ================================================================ rewards
r.get('/rewards', permAny('reward.view', 'reward.manage'), async (req, res) => {
  const w = where();
  if (req.query.status) w.add('status = $?', req.query.status);
  if (req.query.category) w.add('category = $?', req.query.category);
  if (req.query.lowStock === '1') w.add('stock <= low_stock_threshold');
  if (req.query.q) w.add('(name ILIKE $? OR sku ILIKE $? OR barcode = $?)', `%${req.query.q}%`, `%${req.query.q}%`, req.query.q);
  res.json(await paginate(`SELECT * FROM rewards ${w.sql()}`, w.params, { pageSize: 100, ...req.query }, 'status, points_required, name'));
});
const rewardSchema = z.object({
  sku: z.string().max(40).optional().or(z.literal('')), barcode: z.string().max(60).optional().or(z.literal('')), name: z.string().trim().min(1).max(120), description: z.string().max(1000).optional(),
  imageMediaId: zOptUuid, category: z.string().max(40).default('GENERAL'), pointsRequired: z.number().int().min(0), stampsRequired: z.number().int().min(0),
  lowStockThreshold: z.number().int().min(0).default(0), branchIds: z.array(z.string().uuid()).default([]), tierIds: z.array(z.string().uuid()).default([]), memberOnly: z.boolean().default(true),
  limitPerMember: z.number().int().min(1).nullable().optional(), startAt: z.string().nullable().optional(), endAt: z.string().nullable().optional(), status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
}).refine((x) => x.pointsRequired > 0 || x.stampsRequired > 0, 'Set points and/or stamps required');
const rwVals = (b) => [b.sku || null, b.barcode || null, b.name, b.description || null, b.imageMediaId || null, b.category, b.pointsRequired, b.stampsRequired, b.lowStockThreshold, b.branchIds, b.tierIds, b.memberOnly, b.limitPerMember ?? null, b.startAt || null, b.endAt || null, b.status];
r.post('/rewards', perm('reward.manage'), async (req, res) => {
  const b = parse(rewardSchema.and(z.object({ stock: z.number().int().min(0).default(0) })), req.body);
  res.status(201).json(await tx(async (db) => {
    const x = await one(db, `INSERT INTO rewards(sku, barcode, name, description, image_media_id, category, points_required, stamps_required, low_stock_threshold, branch_ids, tier_ids, member_only, limit_per_member, start_at, end_at, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`, rwVals(b));
    if (b.stock > 0) await rewards.moveStock(db, req.ctx, { kind: 'REWARD', id: x.id, type: 'IN', qty: b.stock, reason: 'Initial stock' });
    await crudAudit(db, req.ctx, 'REWARD_CREATE', 'reward', x);
    return x;
  }));
});
r.put('/rewards/:id', perm('reward.manage'), async (req, res) => {
  const b = parse(rewardSchema, req.body);
  res.json(await tx(async (db) => {
    const old = await one(db, 'SELECT * FROM rewards WHERE id = $1', [req.params.id]);
    if (!old) throw fail('NOT_FOUND');
    const x = await one(db, `UPDATE rewards SET sku=$1, barcode=$2, name=$3, description=$4, image_media_id=$5, category=$6, points_required=$7, stamps_required=$8, low_stock_threshold=$9, branch_ids=$10,
      tier_ids=$11, member_only=$12, limit_per_member=$13, start_at=$14, end_at=$15, status=$16 WHERE id = $17 RETURNING *`, [...rwVals(b), old.id]);
    await crudAudit(db, req.ctx, 'REWARD_EDIT', 'reward', x, old);
    return x;
  }));
});
r.delete('/rewards/:id', perm('reward.manage'), async (req, res) => {
  await tx(async (db) => { await db.query(`UPDATE rewards SET status = 'INACTIVE' WHERE id = $1`, [req.params.id]); await audit(db, req.ctx, { action: 'REWARD_DEACTIVATE', targetType: 'reward', targetId: req.params.id }); });
  res.json({ ok: true });
});
/** Rewards a scanned card can redeem right now (counter). */
r.get('/rewards/for-card', perm('reward.redeem'), async (req, res) => {
  const card = await findCard({ query }, req.query.identifier);
  res.json({ card: await cardView({ query }, card), rewards: await rewards.listRewardsForCard({ query }, card, req.ctx) });
});

// ================================================================ redemptions
r.get('/redemptions', permAny('reward.view', 'reward.redeem'), async (req, res) => {
  const w = where();
  if (req.query.status) w.add('r.status = $?', req.query.status);
  if (req.query.q) w.add('(r.code ILIKE $? OR rw.name ILIKE $?)', `%${req.query.q}%`, `%${req.query.q}%`);
  res.json(await paginate(`SELECT r.*, rw.name AS reward_name, c.card_number, m.first_name || ' ' || m.last_name AS member_name, s.first_name AS confirmed_by_name
    FROM redemptions r JOIN rewards rw ON rw.id = r.reward_id JOIN cards c ON c.id = r.card_id LEFT JOIN members m ON m.id = r.member_id LEFT JOIN staff s ON s.id = r.confirmed_by ${w.sql()}`, w.params, req.query, 'r.created_at DESC'));
});
r.get('/redemptions/code/:code', perm('reward.redeem'), async (req, res) => {
  const code = String(req.params.code).trim().toUpperCase().replace(/^.*\/RD\//i, '');
  const x = await one({ query }, `SELECT r.*, rw.name AS reward_name, rw.image_media_id, c.card_number, c.points AS card_points, c.stamps AS card_stamps, m.first_name || ' ' || m.last_name AS member_name
    FROM redemptions r JOIN rewards rw ON rw.id = r.reward_id JOIN cards c ON c.id = r.card_id LEFT JOIN members m ON m.id = r.member_id WHERE r.code = $1`, [code]);
  if (!x) throw fail('REDEMPTION_NOT_FOUND');
  res.json(x);
});
r.post('/redemptions/confirm', perm('reward.redeem'), async (req, res) => {
  const b = parse(z.object({ code: z.string().trim().min(4).max(200) }), req.body);
  const code = b.code.toUpperCase().replace(/^.*\/RD\//i, '');
  const out = await tx((db) => rewards.confirmRedemption(db, req.ctx, code));
  res.json({ redemption: out.redemption, reward: { name: out.reward.name }, txnNo: out.txn.txn_no, card: await cardView({ query }, out.card) });
});
/** Counter redemption: staff scans card, picks reward — request + confirm in one atomic step. */
r.post('/redemptions/counter', perm('reward.redeem'), async (req, res) => {
  const b = parse(z.object({ cardId: z.string().uuid(), rewardId: z.string().uuid() }), req.body);
  const out = await tx(async (db) => {
    const { redemption } = await rewards.requestRedemption(db, req.ctx, { ...b, channel: 'COUNTER' });
    return rewards.confirmRedemption(db, req.ctx, redemption.code);
  });
  res.json({ redemption: out.redemption, reward: { name: out.reward.name }, txnNo: out.txn.txn_no, card: await cardView({ query }, out.card) });
});
r.post('/redemptions/:id/cancel', perm('reward.cancel_redemption'), async (req, res) => {
  const b = parse(z.object({ reason: zReason }), req.body);
  await tx((db) => rewards.cancelRedemption(db, req.ctx, req.params.id, b.reason));
  res.json({ ok: true });
});

// ================================================================ privacy policies
r.get('/privacy-policies', permAny('settings.view'), async (_req, res) => res.json({ items: await many({ query }, `SELECT p.*, (SELECT count(*)::int FROM privacy_consents c WHERE c.policy_id = p.id) AS consents FROM privacy_policies p ORDER BY kind, created_at DESC`) }));
const ppSchema = z.object({ kind: z.enum(['PRIVACY', 'TERMS', 'PDPA']), version: z.string().trim().min(1).max(20), title: z.record(z.string()).default({}), content: z.record(z.string()) });
r.post('/privacy-policies', perm('settings.edit'), async (req, res) => {
  const b = parse(ppSchema, req.body);
  res.status(201).json(await tx(async (db) => { const x = await one(db, 'INSERT INTO privacy_policies(kind, version, title, content, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [b.kind, b.version, b.title, b.content, req.ctx.staff.id]); await audit(db, req.ctx, { action: 'POLICY_CREATE', targetType: 'privacy_policy', targetId: x.id, targetLabel: `${x.kind} v${x.version}` }); return x; }));
});
r.put('/privacy-policies/:id', perm('settings.edit'), async (req, res) => {
  const b = parse(ppSchema.partial(), req.body);
  res.json(await tx(async (db) => {
    const old = await one(db, 'SELECT * FROM privacy_policies WHERE id = $1', [req.params.id]);
    if (!old) throw fail('NOT_FOUND');
    if (old.status !== 'DRAFT') throw fail('CONFLICT', 'Published policies are immutable — create a new version');
    const x = await one(db, 'UPDATE privacy_policies SET title = coalesce($2,title), content = coalesce($3,content), version = coalesce($4, version) WHERE id = $1 RETURNING *', [old.id, b.title ?? null, b.content ?? null, b.version ?? null]);
    return x;
  }));
});
r.post('/privacy-policies/:id/publish', perm('settings.edit'), async (req, res) => {
  res.json(await tx(async (db) => {
    const p = await one(db, 'SELECT * FROM privacy_policies WHERE id = $1', [req.params.id]);
    if (!p) throw fail('NOT_FOUND');
    await db.query(`UPDATE privacy_policies SET status = 'ARCHIVED' WHERE kind = $1 AND status = 'PUBLISHED'`, [p.kind]);
    const x = await one(db, `UPDATE privacy_policies SET status = 'PUBLISHED', published_at = now() WHERE id = $1 RETURNING *`, [p.id]);
    await audit(db, req.ctx, { action: 'POLICY_PUBLISH', targetType: 'privacy_policy', targetId: p.id, targetLabel: `${p.kind} v${p.version}` });
    return x;
  }));
});

export default r;
