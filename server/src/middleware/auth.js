import { resolveSession, loadStaff } from '../services/auth.js';
import { one, query } from '../db/pool.js';
import { sha256 } from '../lib/crypto.js';
import { fail } from '../lib/errors.js';

export const STAFF_COOKIE = 'sc_staff';
export const MEMBER_COOKIE = 'sc_member';

function bearer(req, scheme) {
  const h = req.headers.authorization || '';
  const [s, t] = h.split(' ');
  return s?.toLowerCase() === scheme.toLowerCase() ? t : null;
}

export async function resolveDevice(token) {
  if (!token) return null;
  return one({ query }, 'SELECT * FROM devices WHERE token_hash = $1', [sha256(token)]);
}

/** Populates req.ctx with whatever principals are present. Never rejects. */
export async function attachContext(req, _res, next) {
  try {
    const ctx = { ip: req.ip, staff: null, member: null, device: null, display: null };
    const staffToken = req.cookies?.[STAFF_COOKIE] || bearer(req, 'Staff');
    if (staffToken) {
      const sess = await resolveSession(staffToken, 'STAFF');
      if (sess) {
        const staff = await loadStaff(sess.subject_id);
        if (staff && staff.status === 'ACTIVE') {
          ctx.staff = staff;
          ctx.session = sess;
          ctx.sessionLocked = sess.locked;
          const hdr = req.headers['x-branch-id'];
          ctx.branchId = hdr && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hdr) && (staff.is_owner || staff.permissions.has('branch.manage')) ? hdr : staff.branch_id;
          ctx.viaCookie = !!req.cookies?.[STAFF_COOKIE];
        }
      }
    }
    const memberToken = req.cookies?.[MEMBER_COOKIE] || bearer(req, 'Member');
    if (memberToken) {
      const sess = await resolveSession(memberToken, 'MEMBER');
      if (sess) {
        const m = await one({ query }, `SELECT * FROM members WHERE id = $1 AND status = 'ACTIVE'`, [sess.subject_id]);
        if (m) { ctx.member = m; ctx.memberSession = sess; ctx.memberViaCookie = !!req.cookies?.[MEMBER_COOKIE]; }
      }
    }
    const deviceToken = bearer(req, 'Device') || req.headers['x-device-token'];
    if (deviceToken) {
      const d = await resolveDevice(deviceToken);
      if (d) { ctx.device = d; ctx.branchId = ctx.branchId || d.branch_id; }
    }
    const displayToken = bearer(req, 'Display');
    if (displayToken) {
      const p = await one({ query }, `SELECT p.* FROM sessions s JOIN device_pairings p ON p.id = s.subject_id
        WHERE s.token_hash = $1 AND s.subject_type = 'DISPLAY' AND s.revoked_at IS NULL AND s.expires_at > now() AND p.status = 'PAIRED'`, [sha256(displayToken)]);
      if (p) ctx.display = p;
    }
    req.ctx = ctx;
    next();
  } catch (e) { next(e); }
}

export function requireStaff(req, _res, next) {
  if (!req.ctx?.staff) return next(fail('UNAUTHENTICATED'));
  if (req.ctx.sessionLocked && !req.path.startsWith('/auth')) return next(fail('UNAUTHENTICATED', 'Screen is locked'));
  next();
}

export function requireMember(req, _res, next) {
  if (!req.ctx?.member) return next(fail('UNAUTHENTICATED'));
  next();
}

export function requireDevice(...types) {
  return (req, _res, next) => {
    const d = req.ctx?.device;
    if (!d) return next(fail('UNAUTHENTICATED', 'Device not registered'));
    if (d.status === 'BLOCKED') return next(fail('DEVICE_BLOCKED'));
    if (d.status !== 'ACTIVE') return next(fail('FORBIDDEN', 'Device inactive'));
    if (types.length && !types.includes(d.type)) return next(fail('FORBIDDEN', 'Wrong device type'));
    next();
  };
}

export function requireDisplay(req, _res, next) {
  if (!req.ctx?.display) return next(fail('UNAUTHENTICATED', 'Display not paired'));
  next();
}

/** Require ALL listed permissions. */
export function perm(...codes) {
  return (req, _res, next) => {
    const s = req.ctx?.staff;
    if (!s) return next(fail('UNAUTHENTICATED'));
    for (const c of codes) if (!s.permissions.has(c)) return next(fail('FORBIDDEN', undefined, { permission: c }));
    next();
  };
}

/** Require ANY of the listed permissions. */
export function permAny(...codes) {
  return (req, _res, next) => {
    const s = req.ctx?.staff;
    if (!s) return next(fail('UNAUTHENTICATED'));
    if (!codes.some((c) => s.permissions.has(c))) return next(fail('FORBIDDEN', undefined, { permission: codes.join('|') }));
    next();
  };
}

/**
 * CSRF defence for cookie-authenticated, state-changing requests:
 * cookies are SameSite=Lax AND a custom header is required (cannot be set cross-site without CORS preflight).
 */
export function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const usesCookie = req.cookies?.[STAFF_COOKIE] || req.cookies?.[MEMBER_COOKIE];
  if (usesCookie && req.headers['x-requested-with'] !== 'smartcard') return next(fail('FORBIDDEN', 'CSRF check failed'));
  next();
}
