import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { tx, one, query } from '../db/pool.js';
import { parse, z, zStaffPin } from '../lib/validate.js';
import { fail } from '../lib/errors.js';
import { config } from '../config.js';
import { createSession, revokeSession, verifyStaffCredentials, loadStaff, publicStaff, requireApproval } from '../services/auth.js';
import { verifySecret, hashSecret, safeEqual } from '../lib/crypto.js';
import { requireStaff, STAFF_COOKIE } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { getSettings, publicSettings } from '../services/settings.js';
import { createOwner, getSetupToken } from '../bootstrap.js';
import { logger } from '../lib/logger.js';

export const authLimiter = rateLimit({ windowMs: 60_000, limit: config.isTest ? 1000 : 20, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a minute.' } } });

const STAFF_TTL_MIN = 12 * 60;
export function setStaffCookie(res, token) {
  res.cookie(STAFF_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: STAFF_TTL_MIN * 60000, path: '/' });
}

const r = Router();

r.get('/setup/status', async (_req, res) => {
  const owner = await one({ query }, 'SELECT id FROM staff WHERE is_owner = true LIMIT 1');
  const s = await getSettings();
  res.json({ hasOwner: !!owner, setupCompleted: s.setup.completed, ownerFromEnv: !!(config.owner.username && config.owner.password) });
});

r.post('/setup/owner', authLimiter, async (req, res) => {
  const b = parse(z.object({
    setupToken: z.string().min(8), username: z.string().trim().min(3).max(50).regex(/^[a-zA-Z0-9._-]+$/),
    password: z.string().min(10, 'Password must be at least 10 characters').max(200), pin: zStaffPin,
    firstName: z.string().trim().min(1).max(80), lastName: z.string().trim().max(80).optional(), email: z.string().email().optional().or(z.literal('')),
  }), req.body);
  const token = getSetupToken();
  if (!token || !safeEqual(b.setupToken, token)) { logger.security.warn('setup.bad_token', { ip: req.ip }); throw fail('FORBIDDEN', 'Invalid setup token'); }
  try {
    await createOwner({ ...b, email: b.email || null });
  } catch (e) { if (e.status === 409) throw fail('CONFLICT', 'Owner already exists'); throw e; }
  res.json({ ok: true });
});

r.post('/login', authLimiter, async (req, res) => {
  const b = parse(z.union([
    z.object({ username: z.string().trim().min(1), password: z.string().min(1) }),
    z.object({ employeeCode: z.string().trim().min(1), pin: zStaffPin }),
  ]), req.body);
  const row = await verifyStaffCredentials(b);
  const staff = await loadStaff(row.id);
  const { token } = await createSession({ query }, { subjectType: 'STAFF', subjectId: staff.id, branchId: staff.branch_id, deviceId: req.ctx.device?.id, ip: req.ip, userAgent: req.headers['user-agent'], ttlMinutes: STAFF_TTL_MIN });
  setStaffCookie(res, token);
  await audit(null, { ...req.ctx, staff }, { action: 'LOGIN', targetType: 'staff', targetId: staff.id, targetLabel: staff.employee_code, newData: { method: b.username ? 'PASSWORD' : 'PIN' } });
  res.json({ staff: publicStaff(staff), token: req.headers['x-want-token'] === '1' ? token : undefined });
});

r.post('/logout', async (req, res) => {
  if (req.ctx.session) {
    await revokeSession(req.ctx.session.id);
    await audit(null, req.ctx, { action: 'LOGOUT', targetType: 'staff', targetId: req.ctx.staff.id, targetLabel: req.ctx.staff.employee_code });
  }
  res.clearCookie(STAFF_COOKIE, { path: '/' });
  res.json({ ok: true });
});

r.get('/me', async (req, res) => {
  if (!req.ctx.staff) return res.json({ staff: null, settings: await publicSettings() });
  const s = await getSettings(req.ctx.branchId);
  res.json({
    staff: publicStaff(req.ctx.staff), locked: !!req.ctx.sessionLocked, branchId: req.ctx.branchId,
    settings: await publicSettings(req.ctx.branchId),
    security: { autoLockMinutes: s.security.autoLockMinutes, sessionIdleMinutes: s.security.sessionIdleMinutes, approvalRequired: s.security.approvalRequired },
  });
});

r.post('/lock', requireStaff, async (req, res) => {
  await query('UPDATE sessions SET locked = true WHERE id = $1', [req.ctx.session.id]);
  res.json({ ok: true });
});

// unlock: same staff PIN (or password)
r.post('/unlock', authLimiter, async (req, res) => {
  if (!req.ctx.session) throw fail('UNAUTHENTICATED');
  const b = parse(z.object({ pin: z.string().optional(), password: z.string().optional() }), req.body);
  const s = await one({ query }, 'SELECT pin_hash, password_hash FROM staff WHERE id = $1', [req.ctx.staff.id]);
  const ok = (b.pin && await verifySecret(b.pin, s.pin_hash)) || (b.password && await verifySecret(b.password, s.password_hash));
  if (!ok) { logger.security.warn('auth.unlock_failed', { staffId: req.ctx.staff.id }); throw fail('INVALID_CREDENTIALS'); }
  await query('UPDATE sessions SET locked = false, last_seen_at = now() WHERE id = $1', [req.ctx.session.id]);
  res.json({ ok: true });
});

// switch staff on a shared terminal: verify new staff, revoke the old session
r.post('/switch', authLimiter, async (req, res) => {
  const b = parse(z.object({ employeeCode: z.string().trim().min(1), pin: zStaffPin }), req.body);
  const row = await verifyStaffCredentials(b);
  if (req.ctx.session) await revokeSession(req.ctx.session.id);
  const staff = await loadStaff(row.id);
  const { token } = await createSession({ query }, { subjectType: 'STAFF', subjectId: staff.id, branchId: staff.branch_id, ip: req.ip, userAgent: req.headers['user-agent'], ttlMinutes: STAFF_TTL_MIN });
  setStaffCookie(res, token);
  await audit(null, { ...req.ctx, staff }, { action: 'SWITCH_STAFF', targetType: 'staff', targetId: staff.id, targetLabel: staff.employee_code, oldData: req.ctx.staff ? { from: req.ctx.staff.employee_code } : null });
  res.json({ staff: publicStaff(staff) });
});

r.post('/change-password', requireStaff, async (req, res) => {
  const b = parse(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10).max(200) }), req.body);
  const s = await one({ query }, 'SELECT password_hash FROM staff WHERE id = $1', [req.ctx.staff.id]);
  if (!(await verifySecret(b.currentPassword, s.password_hash))) throw fail('INVALID_CREDENTIALS', 'Current password is incorrect');
  await query('UPDATE staff SET password_hash = $2, updated_at = now() WHERE id = $1', [req.ctx.staff.id, await hashSecret(b.newPassword)]);
  await audit(null, req.ctx, { action: 'PASSWORD_CHANGE', targetType: 'staff', targetId: req.ctx.staff.id });
  res.json({ ok: true });
});

r.post('/change-pin', requireStaff, async (req, res) => {
  const b = parse(z.object({ currentPin: z.string().optional(), currentPassword: z.string().optional(), newPin: zStaffPin }), req.body);
  const s = await one({ query }, 'SELECT pin_hash, password_hash FROM staff WHERE id = $1', [req.ctx.staff.id]);
  const ok = (b.currentPin && await verifySecret(b.currentPin, s.pin_hash)) || (b.currentPassword && await verifySecret(b.currentPassword, s.password_hash));
  if (!ok) throw fail('INVALID_CREDENTIALS');
  await query('UPDATE staff SET pin_hash = $2 WHERE id = $1', [req.ctx.staff.id, await hashSecret(b.newPin)]);
  await audit(null, req.ctx, { action: 'PIN_CHANGE', targetType: 'staff', targetId: req.ctx.staff.id });
  res.json({ ok: true });
});

/** Pre-check manager approval credentials from the approval modal. */
r.post('/approval/check', requireStaff, authLimiter, async (req, res) => {
  const b = parse(z.object({ permission: z.string(), employeeCode: z.string(), pin: zStaffPin }), req.body);
  const approverId = await requireApproval({ staff: { ...req.ctx.staff, permissions: new Set() } }, b.permission, b).catch((e) => { throw e; });
  res.json({ ok: true, approverId });
});

export default r;
