// Settings, staff, roles & permissions, branches, merchants, audit logs, notifications, payment methods.
import { Router } from 'express';
import { tx, one, many, query } from '../db/pool.js';
import { parse, z, zStaffPin, zOptUuid, zReason } from '../lib/validate.js';
import { fail } from '../lib/errors.js';
import { perm, permAny, requireStaff } from '../middleware/auth.js';
import { hashSecret } from '../lib/crypto.js';
import { audit } from '../services/audit.js';
import { getSettings, setGroup, SETTING_GROUPS, DEFAULT_SETTINGS, getStoredGroup, invalidateSettings } from '../services/settings.js';
import { PERMISSION_CATALOG } from '../lib/permissions.js';
import { paginate, where, dateRange } from './_util.js';
import { gatewayInfo } from '../integrations/payment/index.js';
import { promptPayFromSettings } from '../lib/promptpay.js';

const r = Router();
r.use(requireStaff);

// ---------------------------------------------------------------- settings
r.get('/settings', perm('settings.view'), async (req, res) => {
  const branchId = req.query.branchId || null;
  const s = await getSettings(branchId);
  res.json({ settings: s, groups: SETTING_GROUPS, gateway: gatewayInfo() });
});

r.get('/settings/:group', perm('settings.view'), async (req, res) => {
  if (!SETTING_GROUPS.includes(req.params.group)) throw fail('NOT_FOUND');
  const branchId = req.query.branchId || null;
  res.json({ value: (await getSettings(branchId))[req.params.group], stored: await getStoredGroup({ query }, req.params.group, branchId), defaults: DEFAULT_SETTINGS[req.params.group] });
});

const SETTING_VALIDATORS = {
  card: z.object({ length: z.literal(12).optional(), prefix: z.string().regex(/^[0-9]{0,6}$/).optional(), deposit: z.number().min(0).optional(), replacementFee: z.number().min(0).optional(), tapCooldownSec: z.number().int().min(0).max(120).optional(), minBalance: z.number().min(0).optional() }).passthrough(),
  tax: z.object({ vatMode: z.enum(['OFF', 'INCLUSIVE', 'EXCLUSIVE']).optional(), vatRate: z.number().min(0).max(30).optional(), serviceMode: z.enum(['OFF', 'ON']).optional(), serviceRate: z.number().min(0).max(30).optional() }).passthrough(),
  promptpay: z.object({ idType: z.enum(['PHONE', 'TAX_ID', 'EWALLET']).optional(), qrType: z.enum(['STATIC', 'DYNAMIC']).optional(), phone: z.string().regex(/^(0[0-9]{9})?$/, 'Phone must be 10 digits').optional(), taxId: z.string().regex(/^([0-9]{13})?$/, 'Tax ID must be 13 digits').optional(), ewalletId: z.string().regex(/^([0-9]{15})?$/, 'E-Wallet ID must be 15 digits').optional() }).passthrough(),
  security: z.object({ sessionIdleMinutes: z.number().int().min(5).max(1440).optional(), autoLockMinutes: z.number().int().min(0).max(240).optional(), maxFailedLogins: z.number().int().min(3).max(20).optional(), lockoutMinutes: z.number().int().min(1).max(1440).optional() }).passthrough(),
  promotion: z.object({ policy: z.enum(['PRIORITY', 'BEST', 'STACK']).optional() }).passthrough(),
  point: z.object({ earnAmount: z.number().min(0).optional(), earnPoints: z.number().int().min(0).optional() }).passthrough(),
};

r.put('/settings/:group', perm('settings.edit'), async (req, res) => {
  const group = req.params.group;
  if (!SETTING_GROUPS.includes(group)) throw fail('NOT_FOUND');
  if (group === 'security' && !req.ctx.staff.is_owner && !req.ctx.staff.permissions.has('staff.permission')) throw fail('FORBIDDEN', 'Only the owner can change security settings');
  const branchId = req.body.branchId || null;
  const value = req.body.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('VALIDATION_ERROR', 'value must be an object');
  if (SETTING_VALIDATORS[group]) parse(SETTING_VALIDATORS[group], value);
  if (group === 'promptpay') {
    const merged = { ...(await getSettings(branchId)).promptpay, ...value };
    const id = merged.idType === 'TAX_ID' ? merged.taxId : merged.idType === 'EWALLET' ? merged.ewalletId : merged.phone;
    if (id) { try { promptPayFromSettings(merged, 1); } catch (e) { throw fail('VALIDATION_ERROR', e.message); } }
  }
  await tx(async (db) => {
    const old = await getStoredGroup(db, group, branchId);
    const next = { ...(old || {}), ...value };
    await setGroup(db, group, next, req.ctx.staff.id, branchId);
    await audit(db, req.ctx, { action: 'SETTING_CHANGE', targetType: 'settings', targetId: group, targetLabel: branchId ? `${group}@branch` : group, oldData: old, newData: next });
  });
  invalidateSettings();
  res.json({ value: (await getSettings(branchId))[group] });
});

r.delete('/settings/:group/branch/:branchId', perm('settings.edit'), async (req, res) => {
  await tx(async (db) => {
    await db.query('DELETE FROM settings WHERE key = $1 AND branch_id = $2', [req.params.group, req.params.branchId]);
    await audit(db, req.ctx, { action: 'SETTING_CHANGE', targetType: 'settings', targetId: req.params.group, targetLabel: 'branch override removed' });
  });
  invalidateSettings();
  res.json({ ok: true });
});

r.post('/setup/complete', perm('settings.edit'), async (req, res) => {
  await tx(async (db) => {
    await setGroup(db, 'setup', { completed: true, step: 15 }, req.ctx.staff.id);
    await audit(db, req.ctx, { action: 'SETUP_COMPLETE', targetType: 'settings', targetId: 'setup' });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- payment methods
r.get('/payment-methods', requireStaff, async (_req, res) => {
  res.json({ items: await many({ query }, 'SELECT * FROM payment_methods ORDER BY sort'), gateway: gatewayInfo() });
});
r.put('/payment-methods/:code', perm('payment.manage'), async (req, res) => {
  const b = parse(z.object({ enabled: z.boolean().optional(), name: z.string().min(1).max(60).optional(), sort: z.number().int().optional(), config: z.record(z.any()).optional() }), req.body);
  const row = await tx(async (db) => {
    const old = await one(db, 'SELECT * FROM payment_methods WHERE code = $1', [req.params.code]);
    if (!old) throw fail('NOT_FOUND');
    const upd = await one(db, 'UPDATE payment_methods SET enabled = coalesce($2, enabled), name = coalesce($3, name), sort = coalesce($4, sort), config = coalesce($5, config) WHERE code = $1 RETURNING *',
      [req.params.code, b.enabled ?? null, b.name ?? null, b.sort ?? null, b.config ?? null]);
    await audit(db, req.ctx, { action: 'SETTING_CHANGE', targetType: 'payment_method', targetId: req.params.code, oldData: old, newData: upd });
    return upd;
  });
  res.json(row);
});

// ---------------------------------------------------------------- staff
const staffCols = `s.id, s.employee_code, s.username, s.email, s.phone, s.first_name, s.last_name, s.nickname, s.profile_media_id, s.role_id,
  s.branch_id, s.merchant_id, s.is_owner, s.status, s.start_date, s.note, s.max_discount_pct, s.last_login_at, s.created_at, s.locked_until,
  r.code AS role_code, r.name AS role_name, b.name AS branch_name`;

r.get('/staff', perm('staff.view'), async (req, res) => {
  const w = where().add(`s.status <> 'DELETED'`);
  if (req.query.q) w.add(`(s.first_name ILIKE $? OR s.last_name ILIKE $? OR s.employee_code ILIKE $? OR s.username ILIKE $? OR s.nickname ILIKE $?)`, ...Array(5).fill(`%${req.query.q}%`));
  if (req.query.roleId) w.add('s.role_id = $?', req.query.roleId);
  if (req.query.branchId) w.add('s.branch_id = $?', req.query.branchId);
  if (req.query.status) w.add('s.status = $?', req.query.status);
  res.json(await paginate(`SELECT ${staffCols} FROM staff s JOIN roles r ON r.id = s.role_id LEFT JOIN branches b ON b.id = s.branch_id ${w.sql()}`, w.params, req.query, 'is_owner DESC, employee_code'));
});

r.get('/staff/:id', perm('staff.view'), async (req, res) => {
  const s = await one({ query }, `SELECT ${staffCols} FROM staff s JOIN roles r ON r.id = s.role_id LEFT JOIN branches b ON b.id = s.branch_id WHERE s.id = $1`, [req.params.id]);
  if (!s) throw fail('NOT_FOUND');
  const overrides = await many({ query }, 'SELECT permission_code, effect FROM staff_permissions WHERE staff_id = $1', [s.id]);
  res.json({ ...s, overrides });
});

const staffSchema = z.object({
  employeeCode: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9_-]+$/), username: z.string().trim().min(3).max(50).regex(/^[a-zA-Z0-9._-]+$/).optional().or(z.literal('')),
  email: z.string().email().optional().or(z.literal('')), phone: z.string().max(20).optional(), firstName: z.string().trim().min(1).max(80), lastName: z.string().trim().max(80).optional(),
  nickname: z.string().max(40).optional(), profileMediaId: zOptUuid, roleId: z.string().uuid(), branchId: zOptUuid, merchantId: zOptUuid,
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(), startDate: z.string().optional().or(z.literal('')), note: z.string().max(500).optional(),
  maxDiscountPct: z.number().min(0).max(100).nullable().optional(), password: z.string().min(10).max(200).optional().or(z.literal('')), pin: zStaffPin.optional().or(z.literal('')),
});

async function assertRoleAssignable(db, ctx, roleId) {
  const role = await one(db, 'SELECT * FROM roles WHERE id = $1', [roleId]);
  if (!role) throw fail('NOT_FOUND', 'Role not found');
  if (role.code === 'OWNER' && !ctx.staff.is_owner) throw fail('FORBIDDEN', 'Only the owner can assign the Owner role');
  if (role.code === 'SUPER_ADMIN' && !ctx.staff.is_owner) throw fail('FORBIDDEN', 'Only the owner can assign Super Admin');
  return role;
}

r.post('/staff', perm('staff.create'), async (req, res) => {
  const b = parse(staffSchema, req.body);
  if (!b.pin && !b.password) throw fail('VALIDATION_ERROR', 'Set a PIN or a password');
  if (b.password && !b.username) throw fail('VALIDATION_ERROR', 'Username is required for password login');
  const s = await tx(async (db) => {
    await assertRoleAssignable(db, req.ctx, b.roleId);
    const row = await one(db,
      `INSERT INTO staff(employee_code, username, email, phone, first_name, last_name, nickname, profile_media_id, role_id, branch_id, merchant_id,
          status, start_date, note, max_discount_pct, password_hash, pin_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id, employee_code`,
      [b.employeeCode.toUpperCase(), b.username || null, b.email || null, b.phone || null, b.firstName, b.lastName || '', b.nickname || null, b.profileMediaId || null,
        b.roleId, b.branchId || null, b.merchantId || null, b.status || 'ACTIVE', b.startDate || null, b.note || null, b.maxDiscountPct ?? null,
        b.password ? await hashSecret(b.password) : null, b.pin ? await hashSecret(b.pin) : null]);
    await audit(db, req.ctx, { action: 'STAFF_CREATE', targetType: 'staff', targetId: row.id, targetLabel: row.employee_code, newData: { ...b, password: undefined, pin: undefined } });
    return row;
  });
  res.status(201).json(s);
});

r.put('/staff/:id', perm('staff.edit'), async (req, res) => {
  const b = parse(staffSchema.partial(), req.body);
  const out = await tx(async (db) => {
    const old = await one(db, 'SELECT * FROM staff WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!old || old.status === 'DELETED') throw fail('NOT_FOUND');
    if (old.is_owner && !req.ctx.staff.is_owner) throw fail('FORBIDDEN', 'Only the owner can edit the owner account');
    if (b.roleId && b.roleId !== old.role_id) {
      if (!req.ctx.staff.permissions.has('staff.permission')) throw fail('FORBIDDEN', 'Changing roles requires staff.permission');
      await assertRoleAssignable(db, req.ctx, b.roleId);
      if (old.is_owner) throw fail('FORBIDDEN', 'Owner role cannot be changed');
    }
    if (b.maxDiscountPct !== undefined && !req.ctx.staff.permissions.has('staff.permission')) throw fail('FORBIDDEN', 'Setting discount limits requires staff.permission');
    const map = { employeeCode: 'employee_code', username: 'username', email: 'email', phone: 'phone', firstName: 'first_name', lastName: 'last_name', nickname: 'nickname', profileMediaId: 'profile_media_id', roleId: 'role_id', branchId: 'branch_id', merchantId: 'merchant_id', status: 'status', startDate: 'start_date', note: 'note', maxDiscountPct: 'max_discount_pct' };
    const sets = []; const vals = [old.id];
    for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { vals.push(b[k] === '' ? null : k === 'employeeCode' ? b[k].toUpperCase() : b[k]); sets.push(`${col} = $${vals.length}`); }
    if (old.is_owner && b.status && b.status !== 'ACTIVE') throw fail('FORBIDDEN', 'Owner cannot be suspended');
    if (sets.length) await db.query(`UPDATE staff SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals);
    if (b.status === 'SUSPENDED') await db.query(`UPDATE sessions SET revoked_at = now() WHERE subject_type = 'STAFF' AND subject_id = $1 AND revoked_at IS NULL`, [old.id]);
    const neu = await one(db, 'SELECT * FROM staff WHERE id = $1', [old.id]);
    await audit(db, req.ctx, { action: b.roleId && b.roleId !== old.role_id ? 'STAFF_ROLE_CHANGE' : 'STAFF_EDIT', targetType: 'staff', targetId: old.id, targetLabel: old.employee_code, oldData: old, newData: neu });
    return { id: neu.id };
  });
  res.json(out);
});

r.delete('/staff/:id', perm('staff.delete'), async (req, res) => {
  await tx(async (db) => {
    const old = await one(db, 'SELECT * FROM staff WHERE id = $1', [req.params.id]);
    if (!old) throw fail('NOT_FOUND');
    if (old.is_owner) throw fail('FORBIDDEN', 'Owner account cannot be deleted');
    if (old.id === req.ctx.staff.id) throw fail('FORBIDDEN', 'You cannot delete yourself');
    await db.query(`UPDATE staff SET status = 'DELETED', username = NULL, employee_code = employee_code || '#DEL' || extract(epoch from now())::bigint, updated_at = now() WHERE id = $1`, [old.id]);
    await db.query(`UPDATE sessions SET revoked_at = now() WHERE subject_type = 'STAFF' AND subject_id = $1 AND revoked_at IS NULL`, [old.id]);
    await audit(db, req.ctx, { action: 'STAFF_DELETE', targetType: 'staff', targetId: old.id, targetLabel: old.employee_code, oldData: old, reason: req.body?.reason });
  });
  res.json({ ok: true });
});

r.post('/staff/:id/reset-credentials', perm('staff.reset_credentials'), async (req, res) => {
  const b = parse(z.object({ pin: zStaffPin.optional(), password: z.string().min(10).max(200).optional(), unlock: z.boolean().optional() }), req.body);
  await tx(async (db) => {
    const old = await one(db, 'SELECT * FROM staff WHERE id = $1', [req.params.id]);
    if (!old) throw fail('NOT_FOUND');
    if (old.is_owner && !req.ctx.staff.is_owner) throw fail('FORBIDDEN');
    if (b.pin) await db.query('UPDATE staff SET pin_hash = $2 WHERE id = $1', [old.id, await hashSecret(b.pin)]);
    if (b.password) await db.query('UPDATE staff SET password_hash = $2 WHERE id = $1', [old.id, await hashSecret(b.password)]);
    await db.query('UPDATE staff SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [old.id]);
    if (b.pin || b.password) await db.query(`UPDATE sessions SET revoked_at = now() WHERE subject_type = 'STAFF' AND subject_id = $1 AND revoked_at IS NULL`, [old.id]);
    await audit(db, req.ctx, { action: b.password ? 'STAFF_RESET_PASSWORD' : b.pin ? 'STAFF_RESET_PIN' : 'STAFF_UNLOCK', targetType: 'staff', targetId: old.id, targetLabel: old.employee_code });
  });
  res.json({ ok: true });
});

r.put('/staff/:id/permissions', perm('staff.permission'), async (req, res) => {
  const b = parse(z.object({ overrides: z.array(z.object({ code: z.string(), effect: z.enum(['GRANT', 'DENY']) })) }), req.body);
  await tx(async (db) => {
    const s = await one(db, 'SELECT * FROM staff WHERE id = $1', [req.params.id]);
    if (!s) throw fail('NOT_FOUND');
    if (s.is_owner) throw fail('FORBIDDEN', 'Owner always has full access');
    const old = await many(db, 'SELECT permission_code, effect FROM staff_permissions WHERE staff_id = $1', [s.id]);
    await db.query('DELETE FROM staff_permissions WHERE staff_id = $1', [s.id]);
    for (const o of b.overrides) await db.query('INSERT INTO staff_permissions(staff_id, permission_code, effect) VALUES ($1,$2,$3)', [s.id, o.code, o.effect]);
    await audit(db, req.ctx, { action: 'PERMISSION_CHANGE', targetType: 'staff', targetId: s.id, targetLabel: s.employee_code, oldData: old, newData: b.overrides });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- roles
r.get('/permissions', permAny('staff.view', 'staff.permission'), async (_req, res) => res.json({ catalog: PERMISSION_CATALOG }));

r.get('/roles', permAny('staff.view', 'staff.permission'), async (_req, res) => {
  const roles = await many({ query }, `SELECT r.*, (SELECT count(*)::int FROM staff s WHERE s.role_id = r.id AND s.status <> 'DELETED') AS staff_count,
    coalesce((SELECT array_agg(permission_code) FROM role_permissions rp WHERE rp.role_id = r.id), '{}') AS permissions FROM roles r ORDER BY is_system DESC, name`);
  res.json({ items: roles });
});

const roleSchema = z.object({ code: z.string().trim().min(2).max(40).regex(/^[A-Z0-9_]+$/, 'Use UPPER_CASE'), name: z.string().trim().min(2).max(60), description: z.string().max(300).optional(), maxDiscountPct: z.number().min(0).max(100), permissions: z.array(z.string()) });

r.post('/roles', perm('staff.permission'), async (req, res) => {
  const b = parse(roleSchema, req.body);
  const role = await tx(async (db) => {
    const row = await one(db, 'INSERT INTO roles(code, name, description, max_discount_pct) VALUES ($1,$2,$3,$4) RETURNING *', [b.code, b.name, b.description || null, b.maxDiscountPct]);
    for (const p of b.permissions) await db.query('INSERT INTO role_permissions(role_id, permission_code) VALUES ($1,$2)', [row.id, p]);
    await audit(db, req.ctx, { action: 'ROLE_CREATE', targetType: 'role', targetId: row.id, targetLabel: row.code, newData: b });
    return row;
  });
  res.status(201).json(role);
});

r.put('/roles/:id', perm('staff.permission'), async (req, res) => {
  const b = parse(roleSchema.partial(), req.body);
  await tx(async (db) => {
    const old = await one(db, 'SELECT * FROM roles WHERE id = $1', [req.params.id]);
    if (!old) throw fail('NOT_FOUND');
    if (old.code === 'OWNER') throw fail('FORBIDDEN', 'Owner role always has every permission');
    const oldPerms = (await many(db, 'SELECT permission_code FROM role_permissions WHERE role_id = $1', [old.id])).map((x) => x.permission_code);
    await db.query('UPDATE roles SET name = coalesce($2, name), description = coalesce($3, description), max_discount_pct = coalesce($4, max_discount_pct) WHERE id = $1', [old.id, b.name ?? null, b.description ?? null, b.maxDiscountPct ?? null]);
    if (b.permissions) {
      await db.query('DELETE FROM role_permissions WHERE role_id = $1', [old.id]);
      for (const p of b.permissions) await db.query('INSERT INTO role_permissions(role_id, permission_code) VALUES ($1,$2)', [old.id, p]);
    }
    await audit(db, req.ctx, { action: 'PERMISSION_CHANGE', targetType: 'role', targetId: old.id, targetLabel: old.code, oldData: { ...old, permissions: oldPerms }, newData: b });
  });
  res.json({ ok: true });
});

r.delete('/roles/:id', perm('staff.permission'), async (req, res) => {
  await tx(async (db) => {
    const old = await one(db, 'SELECT * FROM roles WHERE id = $1', [req.params.id]);
    if (!old) throw fail('NOT_FOUND');
    if (old.is_system) throw fail('FORBIDDEN', 'System roles cannot be deleted');
    const used = await one(db, `SELECT count(*)::int AS n FROM staff WHERE role_id = $1 AND status <> 'DELETED'`, [old.id]);
    if (used.n) throw fail('CONFLICT', `Role is assigned to ${used.n} staff`);
    await db.query('DELETE FROM roles WHERE id = $1', [old.id]);
    await audit(db, req.ctx, { action: 'ROLE_DELETE', targetType: 'role', targetId: old.id, targetLabel: old.code });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- branches & merchants
r.get('/branches', async (_req, res) => res.json({ items: await many({ query }, 'SELECT * FROM branches ORDER BY code') }));
const branchSchema = z.object({ code: z.string().trim().min(2).max(20).regex(/^[A-Z0-9_-]+$/i), name: z.string().trim().min(1).max(100), logoMediaId: zOptUuid, address: z.string().max(500).optional(), phone: z.string().max(30).optional(), taxId: z.string().max(20).optional(), timezone: z.string().optional(), currency: z.string().length(3).optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional() });
r.post('/branches', perm('branch.manage'), async (req, res) => {
  const b = parse(branchSchema, req.body);
  const row = await tx(async (db) => {
    const x = await one(db, 'INSERT INTO branches(code, name, logo_media_id, address, phone, tax_id, timezone, currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [b.code.toUpperCase(), b.name, b.logoMediaId || null, b.address || null, b.phone || null, b.taxId || null, b.timezone || 'Asia/Bangkok', b.currency || 'THB']);
    await audit(db, req.ctx, { action: 'BRANCH_CREATE', targetType: 'branch', targetId: x.id, targetLabel: x.code, newData: x });
    return x;
  });
  res.status(201).json(row);
});
r.put('/branches/:id', perm('branch.manage'), async (req, res) => {
  const b = parse(branchSchema.partial(), req.body);
  const row = await tx(async (db) => {
    const old = await one(db, 'SELECT * FROM branches WHERE id = $1', [req.params.id]);
    if (!old) throw fail('NOT_FOUND');
    const x = await one(db, `UPDATE branches SET code = coalesce($2, code), name = coalesce($3, name), logo_media_id = coalesce($4, logo_media_id), address = coalesce($5, address),
      phone = coalesce($6, phone), tax_id = coalesce($7, tax_id), timezone = coalesce($8, timezone), currency = coalesce($9, currency), status = coalesce($10, status), updated_at = now() WHERE id = $1 RETURNING *`,
      [old.id, b.code?.toUpperCase() ?? null, b.name ?? null, b.logoMediaId ?? null, b.address ?? null, b.phone ?? null, b.taxId ?? null, b.timezone ?? null, b.currency ?? null, b.status ?? null]);
    await audit(db, req.ctx, { action: 'BRANCH_EDIT', targetType: 'branch', targetId: x.id, targetLabel: x.code, oldData: old, newData: x });
    return x;
  });
  res.json(row);
});

r.get('/merchants', permAny('merchant.view', 'pos.open', 'product.view'), async (_req, res) => res.json({ items: await many({ query }, 'SELECT m.*, b.name AS branch_name FROM merchants m LEFT JOIN branches b ON b.id = m.branch_id ORDER BY m.merchant_code') }));
const merchantSchema = z.object({ merchantCode: z.string().trim().min(2).max(20), name: z.string().trim().min(1).max(100), logoMediaId: zOptUuid, branchId: zOptUuid, commissionPct: z.number().min(0).max(100).optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional() });
r.post('/merchants', perm('merchant.manage'), async (req, res) => {
  const b = parse(merchantSchema, req.body);
  const row = await tx(async (db) => {
    const x = await one(db, 'INSERT INTO merchants(merchant_code, name, logo_media_id, branch_id, commission_pct) VALUES ($1,$2,$3,$4,$5) RETURNING *', [b.merchantCode.toUpperCase(), b.name, b.logoMediaId || null, b.branchId || null, b.commissionPct || 0]);
    await audit(db, req.ctx, { action: 'MERCHANT_CREATE', targetType: 'merchant', targetId: x.id, targetLabel: x.merchant_code, newData: x });
    return x;
  });
  res.status(201).json(row);
});
r.put('/merchants/:id', perm('merchant.manage'), async (req, res) => {
  const b = parse(merchantSchema.partial(), req.body);
  const row = await tx(async (db) => {
    const old = await one(db, 'SELECT * FROM merchants WHERE id = $1', [req.params.id]);
    if (!old) throw fail('NOT_FOUND');
    const x = await one(db, 'UPDATE merchants SET name = coalesce($2,name), logo_media_id = coalesce($3, logo_media_id), branch_id = coalesce($4, branch_id), commission_pct = coalesce($5, commission_pct), status = coalesce($6, status) WHERE id = $1 RETURNING *',
      [old.id, b.name ?? null, b.logoMediaId ?? null, b.branchId ?? null, b.commissionPct ?? null, b.status ?? null]);
    await audit(db, req.ctx, { action: 'MERCHANT_EDIT', targetType: 'merchant', targetId: x.id, targetLabel: x.merchant_code, oldData: old, newData: x });
    return x;
  });
  res.json(row);
});

// ---------------------------------------------------------------- audit logs
r.get('/audit-logs', perm('audit.view'), async (req, res) => {
  const w = where();
  if (req.query.action) w.add('a.action = $?', req.query.action);
  if (req.query.actorId) w.add('a.actor_id = $?', req.query.actorId);
  if (req.query.targetType) w.add('a.target_type = $?', req.query.targetType);
  if (req.query.targetId) w.add('a.target_id = $?', req.query.targetId);
  if (req.query.branchId) w.add('a.branch_id = $?', req.query.branchId);
  if (req.query.q) w.add('(a.target_label ILIKE $? OR a.actor_name ILIKE $? OR a.reason ILIKE $?)', `%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`);
  if (req.query.range || req.query.from) {
    const d = dateRange(req.query);
    w.add(`a.created_at >= ($?::timestamp AT TIME ZONE '${d.tz}')`, d.start).add(`a.created_at < ($?::timestamp AT TIME ZONE '${d.tz}')`, d.end);
  }
  res.json(await paginate(`SELECT a.*, ap.first_name AS approver_name FROM audit_logs a LEFT JOIN staff ap ON ap.id = a.approver_id ${w.sql()}`, w.params, req.query, 'created_at DESC'));
});
r.get('/audit-logs/actions', perm('audit.view'), async (_req, res) => res.json({ items: (await many({ query }, 'SELECT DISTINCT action FROM audit_logs ORDER BY action')).map((x) => x.action) }));

// ---------------------------------------------------------------- notifications (staff)
r.get('/notifications', async (req, res) => {
  const items = await many({ query },
    `SELECT n.*, (nr.staff_id IS NOT NULL) AS read FROM notifications n
       LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.staff_id = $1
      WHERE n.audience = 'ALL_STAFF' OR (n.audience = 'STAFF' AND n.staff_id = $1) OR (n.audience = 'BRANCH' AND n.branch_id = $2)
      ORDER BY n.created_at DESC LIMIT 100`, [req.ctx.staff.id, req.ctx.branchId || null]);
  res.json({ items, unread: items.filter((i) => !i.read).length });
});
r.post('/notifications/read', async (req, res) => {
  const ids = parse(z.object({ ids: z.array(z.string().uuid()).optional(), all: z.boolean().optional() }), req.body);
  if (ids.all) {
    await query(`INSERT INTO notification_reads(notification_id, staff_id) SELECT n.id, $1 FROM notifications n WHERE n.audience IN ('ALL_STAFF','BRANCH','STAFF') ON CONFLICT DO NOTHING`, [req.ctx.staff.id]);
  } else for (const id of ids.ids || []) await query('INSERT INTO notification_reads(notification_id, staff_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, req.ctx.staff.id]);
  res.json({ ok: true });
});

export default r;
export { zReason };
