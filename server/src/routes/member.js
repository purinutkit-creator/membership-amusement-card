// Member Portal API (customer-facing). Auth: phone + 6-digit PIN, httpOnly cookie.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { tx, one, many, query } from '../db/pool.js';
import { parse, z, zPhone, zPin6 } from '../lib/validate.js';
import { fail } from '../lib/errors.js';
import { requireMember, MEMBER_COOKIE } from '../middleware/auth.js';
import { createSession, revokeSession, verifyMemberCredentials } from '../services/auth.js';
import * as members from '../services/members.js';
import * as rewards from '../services/rewards.js';
import { convertStamps } from '../services/loyalty.js';
import { createOnlineTopup, handleGatewayWebhook } from '../services/orders.js';
import { getSettings } from '../services/settings.js';
import { gatewayInfo } from '../integrations/payment/index.js';
import { getOtpProvider } from '../integrations/otp/index.js';
import { hashSecret, verifySecret, randomDigits, randomToken } from '../lib/crypto.js';
import { audit } from '../services/audit.js';
import { config } from '../config.js';
import { timeline } from './core.js';

const r = Router();
const limiter = rateLimit({ windowMs: 60_000, limit: config.isTest ? 1000 : 15, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a minute.' } } });

async function startSession(req, res, memberId) {
  const s = await getSettings();
  const days = s.security.memberSessionDays || 30;
  const { token } = await createSession({ query }, { subjectType: 'MEMBER', subjectId: memberId, ip: req.ip, userAgent: req.headers['user-agent'], ttlMinutes: days * 1440 });
  res.cookie(MEMBER_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: days * 86400000, path: '/' });
}

async function publishedPolicies() {
  return many({ query }, `SELECT id, kind, version, title, content FROM privacy_policies WHERE status = 'PUBLISHED' ORDER BY kind`);
}

r.get('/policies', async (_req, res) => res.json({ items: await publishedPolicies() }));

r.post('/register', limiter, async (req, res) => {
  const b = parse(z.object({
    phone: zPhone, firstName: z.string().trim().min(1).max(80), lastName: z.string().trim().min(1).max(80), pin: zPin6,
    email: z.string().email().optional().or(z.literal('')), birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
    gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED']).optional().or(z.literal('')), address: z.string().max(500).optional(),
    customFields: z.record(z.any()).optional(), acceptedPolicyIds: z.array(z.string().uuid()).default([]), language: z.enum(['th', 'en', 'zh']).optional(),
  }), req.body);
  const s = await getSettings();
  const policies = await publishedPolicies();
  if (s.privacy.requireAtRegistration) {
    const missing = policies.filter((p) => !b.acceptedPolicyIds.includes(p.id));
    if (missing.length) throw fail('VALIDATION_ERROR', 'Please accept the privacy policy and terms', { missing: missing.map((m) => m.kind) });
  }
  const m = await tx(async (db) => {
    const row = await members.createMember(db, { ip: req.ip }, { ...b, email: b.email || null, birthday: b.birthday || null, gender: b.gender || null });
    for (const id of b.acceptedPolicyIds) if (policies.find((p) => p.id === id)) await db.query('INSERT INTO privacy_consents(policy_id, member_id, language, ip) VALUES ($1,$2,$3,$4)', [id, row.id, b.language || null, req.ip]);
    return row;
  });
  await startSession(req, res, m.id);
  res.status(201).json(await members.memberSummary({ query }, m.id));
});

r.post('/login', limiter, async (req, res) => {
  const b = parse(z.object({ phone: zPhone, pin: zPin6 }), req.body);
  const m = await verifyMemberCredentials(b.phone, b.pin);
  await startSession(req, res, m.id);
  await audit(null, { member: m, ip: req.ip }, { action: 'MEMBER_LOGIN', targetType: 'member', targetId: m.id, targetLabel: m.member_code });
  res.json(await members.memberSummary({ query }, m.id));
});

/** Card QR (secure token) -> verify with member PIN (never auto-login from QR). */
r.post('/card-login', limiter, async (req, res) => {
  const b = parse(z.object({ token: z.string().min(16).max(100), pin: zPin6 }), req.body);
  const card = await one({ query }, `SELECT c.* FROM qr_tokens q JOIN cards c ON c.id = q.target_id WHERE q.token = $1 AND q.kind = 'CARD_PORTAL' AND q.revoked_at IS NULL AND (q.expires_at IS NULL OR q.expires_at > now())`, [b.token]);
  if (!card || !card.member_id) throw fail('INVALID_CREDENTIALS', 'Card is not linked to a member account');
  const m = await one({ query }, 'SELECT phone FROM members WHERE id = $1', [card.member_id]);
  const row = await verifyMemberCredentials(m.phone, b.pin);
  await startSession(req, res, row.id);
  res.json({ ...(await members.memberSummary({ query }, row.id)), focusCardId: card.id });
});

r.post('/logout', async (req, res) => {
  if (req.ctx.memberSession) await revokeSession(req.ctx.memberSession.id);
  res.clearCookie(MEMBER_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// ---- forgot PIN via OTP (requires a configured OTP provider; otherwise staff resets the PIN)
r.post('/forgot-pin/request', limiter, async (req, res) => {
  const b = parse(z.object({ phone: zPhone }), req.body);
  const provider = getOtpProvider();
  const s = await getSettings();
  if (!provider || !s.member.otpEnabled) throw fail('CONFLICT', 'Online PIN reset is not available. Please contact our staff to reset your PIN.', { contactStaff: true });
  const m = await one({ query }, `SELECT id FROM members WHERE phone = $1 AND status = 'ACTIVE'`, [b.phone]);
  if (m) {
    const code = randomDigits(6);
    await query(`INSERT INTO otp_requests(phone, purpose, code_hash, expires_at) VALUES ($1,'RESET_PIN',$2, now() + interval '5 minutes')`, [b.phone, await hashSecret(code)]);
    await provider.send(b.phone, code);
  }
  res.json({ ok: true }); // same answer whether or not the phone exists
});
r.post('/forgot-pin/verify', limiter, async (req, res) => {
  const b = parse(z.object({ phone: zPhone, code: z.string().regex(/^[0-9]{6}$/), newPin: zPin6 }), req.body);
  const otp = await one({ query }, `SELECT * FROM otp_requests WHERE phone = $1 AND purpose = 'RESET_PIN' AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [b.phone]);
  if (!otp || otp.attempts >= 5) throw fail('INVALID_CREDENTIALS', 'Code is invalid or expired');
  if (!(await verifySecret(b.code, otp.code_hash))) { await query('UPDATE otp_requests SET attempts = attempts + 1 WHERE id = $1', [otp.id]); throw fail('INVALID_CREDENTIALS', 'Code is invalid or expired'); }
  const m = await one({ query }, `SELECT id FROM members WHERE phone = $1 AND status = 'ACTIVE'`, [b.phone]);
  if (!m) throw fail('MEMBER_NOT_FOUND');
  await tx(async (db) => {
    await db.query('UPDATE otp_requests SET used_at = now() WHERE id = $1', [otp.id]);
    await members.resetMemberPin(db, { member: { id: m.id, first_name: 'self' }, ip: req.ip }, m.id, b.newPin);
  });
  res.json({ ok: true });
});

// ================================================================ authenticated
r.use(requireMember);

r.get('/me', async (req, res) => res.json(await members.memberSummary({ query }, req.ctx.member.id)));

r.put('/me', async (req, res) => {
  const b = parse(z.object({ nickname: z.string().max(40).optional(), email: z.string().email().optional().or(z.literal('')), language: z.enum(['th', 'en', 'zh']).optional(), address: z.string().max(500).optional() }), req.body);
  await tx((db) => members.updateMember(db, { member: req.ctx.member, ip: req.ip }, req.ctx.member.id, b));
  res.json(await members.memberSummary({ query }, req.ctx.member.id));
});

r.post('/change-pin', limiter, async (req, res) => {
  const b = parse(z.object({ currentPin: zPin6, newPin: zPin6 }), req.body);
  if (!(await verifySecret(b.currentPin, req.ctx.member.pin_hash))) throw fail('INVALID_CREDENTIALS', 'Current PIN is incorrect');
  await query('UPDATE members SET pin_hash = $2 WHERE id = $1', [req.ctx.member.id, await hashSecret(b.newPin)]);
  await query(`UPDATE sessions SET revoked_at = now() WHERE subject_type = 'MEMBER' AND subject_id = $1 AND id <> $2`, [req.ctx.member.id, req.ctx.memberSession.id]);
  res.json({ ok: true });
});

async function myCard(req, id) {
  const c = await one({ query }, 'SELECT * FROM cards WHERE id = $1 AND member_id = $2', [id, req.ctx.member.id]);
  if (!c) throw fail('CARD_NOT_FOUND');
  return c;
}

r.get('/cards/:id', async (req, res) => {
  const c = await myCard(req, req.params.id);
  const { cardView, ensurePortalToken } = await import('../services/cards.js');
  const token = c.status === 'ACTIVE' ? await ensurePortalToken({ query }, c.id) : null;
  res.json({ ...(await cardView({ query }, c)), portalUrl: token ? `${config.publicUrl}/c/${token}` : null });
});

r.get('/timeline', async (req, res) => res.json(await timeline('member_id', req.ctx.member.id, req.query)));

r.get('/rewards', async (req, res) => {
  const cardId = req.query.cardId;
  const card = cardId ? await myCard(req, cardId) : await one({ query }, `SELECT * FROM cards WHERE member_id = $1 AND status = 'ACTIVE' ORDER BY points DESC LIMIT 1`, [req.ctx.member.id]);
  res.json({ cardId: card?.id || null, items: await rewards.listRewardsForCard({ query }, card, {}) });
});

r.post('/rewards/:id/redeem', async (req, res) => {
  const b = parse(z.object({ cardId: z.string().uuid() }), req.body);
  await myCard(req, b.cardId);
  const out = await tx((db) => rewards.requestRedemption(db, { member: req.ctx.member, ip: req.ip }, { rewardId: req.params.id, cardId: b.cardId, channel: 'PORTAL' }));
  res.status(201).json({ code: out.redemption.code, expiresAt: out.redemption.expires_at, reward: { id: out.reward.id, name: out.reward.name }, redemptionId: out.redemption.id, qr: `RD/${out.redemption.code}` });
});

r.get('/redemptions', async (req, res) => {
  res.json({ items: await many({ query }, `SELECT r.id, r.code, r.status, r.points, r.stamps, r.created_at, r.expires_at, r.confirmed_at, rw.name AS reward_name, rw.image_media_id FROM redemptions r JOIN rewards rw ON rw.id = r.reward_id WHERE r.member_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [req.ctx.member.id]) });
});
r.post('/redemptions/:id/cancel', async (req, res) => {
  await tx((db) => rewards.cancelRedemption(db, { member: req.ctx.member, ip: req.ip }, req.params.id, 'Cancelled by member'));
  res.json({ ok: true });
});

r.post('/cards/:id/convert-stamps', async (req, res) => {
  await myCard(req, req.params.id);
  const out = await tx((db) => convertStamps(db, { member: req.ctx.member }, { cardId: req.params.id, by: 'MEMBER' }));
  res.json({ txnNo: out.txn.txn_no, points: out.card.points, stamps: out.card.stamps });
});

r.get('/packages', async (req, res) => {
  const m = req.ctx.member;
  const items = await many({ query }, `SELECT id, name, pay_amount, bonus_amount, point_bonus, stamp_bonus, image_media_id, member_only, tier_ids FROM topup_packages
    WHERE status = 'ACTIVE' AND (start_at IS NULL OR start_at <= now()) AND (end_at IS NULL OR end_at > now()) AND (usage_limit IS NULL OR used_count < usage_limit)
      AND (cardinality(tier_ids) = 0 OR $1 = ANY(tier_ids)) ORDER BY sort, pay_amount`, [m.tier_id]);
  const s = await getSettings();
  res.json({ items, allowCustomAmount: s.topup.allowCustomAmount, minTopup: s.wallet.minTopup, maxTopup: s.wallet.maxTopup, gateway: gatewayInfo() });
});

r.post('/topup', limiter, async (req, res) => {
  const b = parse(z.object({ cardId: z.string().uuid(), packageId: z.string().uuid().optional(), amount: z.number().positive().max(1_000_000).optional() }), req.body);
  if (!b.packageId && !b.amount) throw fail('VALIDATION_ERROR', 'Choose a package or amount');
  if (!gatewayInfo().configured) throw fail('PAYMENT_FAILED', 'Online top-up is not available yet. Please top up at the counter.');
  const out = await createOnlineTopup(req.ctx.member, b);
  const p = out.payment;
  res.status(201).json({ paymentId: p.id, paymentNo: p.payment_no, amount: Number(p.amount), status: p.status, qrPayload: p.qr_payload, redirectUrl: p.meta?.redirectUrl || null, expiresAt: p.expires_at, testMode: gatewayInfo().testMode });
});

r.get('/payments/:id', async (req, res) => {
  const p = await one({ query }, `SELECT p.id, p.payment_no, p.status, p.amount, p.qr_payload, p.expires_at, p.paid_at FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = $1 AND o.member_id = $2`, [req.params.id, req.ctx.member.id]);
  if (!p) throw fail('NOT_FOUND');
  res.json(p);
});

/** TEST MODE: simulate the gateway confirming payment (mock gateway only, never in production). */
r.post('/payments/:id/simulate', async (req, res) => {
  if (config.isProd) throw fail('FORBIDDEN');
  const p = await one({ query }, `SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = $1 AND o.member_id = $2`, [req.params.id, req.ctx.member.id]);
  if (!p || p.provider !== 'mock') throw fail('NOT_FOUND');
  const body = { eventId: `evt_${randomToken(8)}`, providerRef: p.provider_ref, paymentNo: p.payment_no, status: 'PAID', amount: Number(p.amount) };
  res.json(await handleGatewayWebhook('mock', { ...body, raw: body }));
});

r.get('/promotions', async (_req, res) => {
  res.json({ items: await many({ query }, `SELECT id, name, description, applies_to, effect_type, effect_value, start_at, end_at, media_id FROM promotions WHERE status = 'ACTIVE' AND (start_at IS NULL OR start_at <= now()) AND (end_at IS NULL OR end_at > now()) ORDER BY priority`) });
});

r.get('/notifications', async (req, res) => {
  res.json({ items: await many({ query }, `SELECT * FROM notifications WHERE member_id = $1 ORDER BY created_at DESC LIMIT 50`, [req.ctx.member.id]) });
});
r.post('/notifications/read', async (req, res) => {
  await query('UPDATE notifications SET read_at = now() WHERE member_id = $1 AND read_at IS NULL', [req.ctx.member.id]);
  res.json({ ok: true });
});

r.get('/consents', async (req, res) => {
  res.json({ items: await many({ query }, `SELECT pc.accepted_at, pp.id AS policy_id, pp.kind, pp.version FROM privacy_consents pc JOIN privacy_policies pp ON pp.id = pc.policy_id WHERE pc.member_id = $1 ORDER BY pc.accepted_at DESC`, [req.ctx.member.id]), policies: await publishedPolicies() });
});
r.post('/consents', async (req, res) => {
  const b = parse(z.object({ policyIds: z.array(z.string().uuid()).min(1), language: z.string().optional() }), req.body);
  for (const id of b.policyIds) await query(`INSERT INTO privacy_consents(policy_id, member_id, language, ip) SELECT id, $2, $3, $4 FROM privacy_policies WHERE id = $1 AND status = 'PUBLISHED'`, [id, req.ctx.member.id, b.language || null, req.ip]);
  res.json({ ok: true });
});

export default r;
