import { query, one, many } from '../db/pool.js';
import { hashSecret, verifySecret, randomToken, sha256 } from '../lib/crypto.js';
import { fail } from '../lib/errors.js';
import { ALL_PERMISSIONS } from '../lib/permissions.js';
import { getGroup } from './settings.js';
import { logger } from '../lib/logger.js';

const ALL_CODES = ALL_PERMISSIONS.map((p) => p.code);

/** Load staff with role + effective permission set. */
export async function loadStaff(staffId) {
  const s = await one({ query },
    `SELECT s.*, r.code AS role_code, r.name AS role_name, r.max_discount_pct AS role_max_discount
       FROM staff s JOIN roles r ON r.id = s.role_id WHERE s.id = $1`, [staffId]);
  if (!s) return null;
  let perms;
  if (s.is_owner) perms = new Set(ALL_CODES);
  else {
    const rp = await many({ query }, 'SELECT permission_code FROM role_permissions WHERE role_id = $1', [s.role_id]);
    perms = new Set(rp.map((r) => r.permission_code));
    const sp = await many({ query }, 'SELECT permission_code, effect FROM staff_permissions WHERE staff_id = $1', [s.id]);
    for (const p of sp) p.effect === 'GRANT' ? perms.add(p.permission_code) : perms.delete(p.permission_code);
  }
  s.permissions = perms;
  s.max_discount = s.is_owner ? 100 : Number(s.max_discount_pct ?? s.role_max_discount ?? 0);
  return s;
}

export function publicStaff(s) {
  if (!s) return null;
  return {
    id: s.id, employeeCode: s.employee_code, username: s.username, firstName: s.first_name, lastName: s.last_name,
    nickname: s.nickname, email: s.email, phone: s.phone, role: s.role_code, roleName: s.role_name, roleId: s.role_id,
    branchId: s.branch_id, merchantId: s.merchant_id, isOwner: s.is_owner, status: s.status, profileMediaId: s.profile_media_id,
    maxDiscount: s.max_discount, permissions: s.permissions ? [...s.permissions] : undefined,
  };
}

export async function createSession(db, { subjectType, subjectId, branchId = null, deviceId = null, ip, userAgent, ttlMinutes }) {
  const token = randomToken(32);
  const row = await one(db,
    `INSERT INTO sessions(token_hash, subject_type, subject_id, branch_id, device_id, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' minutes')::interval) RETURNING id`,
    [sha256(token), subjectType, subjectId, branchId, deviceId, ip || null, (userAgent || '').slice(0, 300), String(ttlMinutes)]);
  return { token, sessionId: row.id };
}

export async function resolveSession(token, subjectType) {
  if (!token) return null;
  const s = await one({ query },
    `SELECT * FROM sessions WHERE token_hash = $1 AND subject_type = $2 AND revoked_at IS NULL AND expires_at > now()`,
    [sha256(token), subjectType]);
  if (!s) return null;
  if (subjectType === 'STAFF') {
    const sec = await getGroup('security');
    const idleMs = Number(sec.sessionIdleMinutes || 60) * 60000;
    if (Date.now() - new Date(s.last_seen_at).getTime() > idleMs) {
      await query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [s.id]);
      return null;
    }
  }
  if (Date.now() - new Date(s.last_seen_at).getTime() > 30000) {
    query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [s.id]).catch(() => {});
  }
  return s;
}

export async function revokeSession(sessionId) {
  await query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [sessionId]);
}

async function registerFailure(table, row, sec) {
  const attempts = row.failed_attempts + 1;
  const lock = attempts >= sec.maxFailedLogins;
  await query(`UPDATE ${table} SET failed_attempts = $2, locked_until = $3 WHERE id = $1`,
    [row.id, lock ? 0 : attempts, lock ? new Date(Date.now() + sec.lockoutMinutes * 60000) : null]);
  if (lock) logger.security.warn('auth.account_locked', { table, id: row.id });
}

/** Staff login with username+password or employeeCode+PIN. Returns staff row. */
export async function verifyStaffCredentials({ username, password, employeeCode, pin }) {
  const sec = await getGroup('security');
  const row = username
    ? await one({ query }, `SELECT * FROM staff WHERE lower(username) = lower($1) AND status <> 'DELETED'`, [username])
    : await one({ query }, `SELECT * FROM staff WHERE upper(employee_code) = upper($1) AND status <> 'DELETED'`, [employeeCode]);
  if (!row) {
    await verifySecret('x', 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86)); // equalize timing
    throw fail('INVALID_CREDENTIALS');
  }
  if (row.locked_until && new Date(row.locked_until) > new Date()) throw fail('ACCOUNT_LOCKED');
  const ok = username ? await verifySecret(password, row.password_hash) : await verifySecret(pin, row.pin_hash);
  if (!ok) {
    await registerFailure('staff', row, sec);
    logger.security.warn('auth.staff_login_failed', { staffId: row.id });
    throw fail('INVALID_CREDENTIALS');
  }
  if (row.status !== 'ACTIVE') throw fail('FORBIDDEN', 'Account is suspended');
  await query('UPDATE staff SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [row.id]);
  return row;
}

export async function verifyMemberCredentials(phone, pin) {
  const sec = await getGroup('security');
  const row = await one({ query }, `SELECT * FROM members WHERE phone = $1 AND status NOT IN ('MERGED','DELETED')`, [phone]);
  if (!row || !row.pin_hash) throw fail('INVALID_CREDENTIALS', 'Phone number or PIN is incorrect');
  if (row.locked_until && new Date(row.locked_until) > new Date()) throw fail('ACCOUNT_LOCKED');
  if (!(await verifySecret(pin, row.pin_hash))) {
    await registerFailure('members', row, sec);
    throw fail('INVALID_CREDENTIALS', 'Phone number or PIN is incorrect');
  }
  if (row.status !== 'ACTIVE') throw fail('MEMBER_SUSPENDED');
  await query('UPDATE members SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [row.id]);
  return row;
}

/**
 * Manager approval. If `permCode` is listed in security.approvalRequired and the actor
 * cannot self-approve, valid approver credentials (employeeCode + PIN of a staff with
 * approval.approve) must be supplied. Returns approver staff id or null.
 */
export async function requireApproval(ctx, permCode, approval) {
  const sec = await getGroup('security');
  if (!sec.approvalRequired?.includes(permCode)) return null;
  if (ctx.staff?.permissions?.has('approval.approve')) return ctx.staff.id;
  if (!approval?.employeeCode || !approval?.pin) throw fail('APPROVAL_REQUIRED', undefined, { permission: permCode });
  let approver;
  try {
    approver = await verifyStaffCredentials({ employeeCode: approval.employeeCode, pin: approval.pin });
  } catch {
    throw fail('INVALID_APPROVAL');
  }
  const full = await loadStaff(approver.id);
  if (!full.permissions.has('approval.approve') || !full.permissions.has(permCode)) throw fail('INVALID_APPROVAL');
  logger.security.info('approval.granted', { permCode, approverId: full.id, staffId: ctx.staff?.id });
  return full.id;
}

export { hashSecret };
