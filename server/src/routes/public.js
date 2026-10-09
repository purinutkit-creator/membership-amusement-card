// Unauthenticated endpoints: public settings, signage playlists, digital receipts, card portal landing, gateway webhooks.
import { Router } from 'express';
import { one, many, query } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { publicSettings, getSettings } from '../services/settings.js';
import { getGateway } from '../integrations/payment/index.js';
import { handleGatewayWebhook } from '../services/orders.js';
import { localParts, inTimeWindow } from '../lib/time.js';
import { logger } from '../lib/logger.js';
import { gatewayInfo } from '../integrations/payment/index.js';
import { config } from '../config.js';

const r = Router();

r.get('/settings', async (req, res) => res.json({ ...(await publicSettings(req.query.branchId || null)), env: { testMode: !config.isProd, gateway: gatewayInfo() } }));

r.get('/playlists', async (_req, res) => res.json({ items: await many({ query }, `SELECT id, name, target FROM display_playlists WHERE status = 'ACTIVE' ORDER BY name`) }));

/** Items currently scheduled to play (date range, day-of-week, time window), approved media only. */
r.get('/playlists/:id/now', async (req, res) => {
  const p = await one({ query }, `SELECT * FROM display_playlists WHERE id = $1 AND status = 'ACTIVE'`, [req.params.id]);
  if (!p) throw fail('NOT_FOUND', 'Playlist not found');
  const s = await getSettings(p.branch_id);
  const now = localParts(new Date(), s.general.timezone);
  const items = await many({ query }, `SELECT i.id, i.item_type, i.text_content, i.duration_sec, i.sort, i.priority, i.days_of_week, i.start_time::text, i.end_time::text, i.start_date, i.end_date, m.url, m.kind, m.mime
    FROM display_items i LEFT JOIN media m ON m.id = i.media_id
    WHERE i.playlist_id = $1 AND i.enabled AND (i.item_type = 'TEXT' OR m.status = 'APPROVED') ORDER BY i.priority DESC, i.sort, i.created_at`, [p.id]);
  const active = items.filter((i) => (!i.start_date || i.start_date <= now.ymd) && (!i.end_date || i.end_date >= now.ymd)
    && (!i.days_of_week?.length || i.days_of_week.includes(now.dow)) && (!i.start_time || !i.end_time || inTimeWindow(now.minutes, i.start_time.slice(0, 5), i.end_time.slice(0, 5))));
  res.json({ id: p.id, name: p.name, items: active, fonts: s.fonts, theme: s.theme });
});

r.get('/receipts/:token', async (req, res) => {
  const rc = await one({ query }, `SELECT r.* FROM qr_tokens q JOIN receipts r ON r.id = q.target_id WHERE q.token = $1 AND q.kind = 'RECEIPT' AND q.revoked_at IS NULL`, [req.params.token]);
  if (!rc) throw fail('NOT_FOUND', 'Receipt not found');
  res.json({ receiptNo: rc.receipt_no, type: rc.type, data: rc.data, createdAt: rc.created_at });
});

/** Card QR landing: confirms the token is valid without exposing balance (PIN required). */
r.get('/card-portal/:token', async (req, res) => {
  const c = await one({ query }, `SELECT c.card_number, c.member_id, c.status FROM qr_tokens q JOIN cards c ON c.id = q.target_id WHERE q.token = $1 AND q.kind = 'CARD_PORTAL' AND q.revoked_at IS NULL`, [req.params.token]);
  if (!c) throw fail('NOT_FOUND', 'This card link is no longer valid');
  res.json({ valid: true, cardMasked: `********${c.card_number.slice(-4)}`, hasMember: !!c.member_id, status: c.status });
});

/** Media by id (approved only) — lets any surface render <img src="/api/public/media/:id">. */
r.get('/media/:id', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw fail('NOT_FOUND');
  const m = await one({ query }, `SELECT url FROM media WHERE id = $1 AND status = 'APPROVED'`, [req.params.id]);
  if (!m) throw fail('NOT_FOUND');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.redirect(302, m.url);
});

r.get('/policies', async (_req, res) => res.json({ items: await many({ query }, `SELECT id, kind, version, title, content, published_at FROM privacy_policies WHERE status = 'PUBLISHED'`) }));

/** Payment gateway webhook — signature-verified and idempotent. */
r.post('/payments/webhook/:provider', async (req, res) => {
  let gw;
  try { gw = getGateway(req.params.provider); } catch { gw = null; }
  if (!gw) throw fail('NOT_FOUND', 'Unknown provider');
  let evt;
  try { evt = gw.parseWebhook(req); } catch (e) { logger.security.warn('webhook.rejected', { provider: req.params.provider, message: e.message, ip: req.ip }); return res.status(e.status || 400).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } }); }
  logger.payment.info('webhook.received', { provider: gw.name, eventId: evt.eventId, status: evt.status });
  res.json(await handleGatewayWebhook(gw.name, evt));
});

export default r;
