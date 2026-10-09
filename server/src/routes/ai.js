import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { tx, one, many, query } from '../db/pool.js';
import { parse, z, zOptUuid } from '../lib/validate.js';
import { fail } from '../lib/errors.js';
import { perm, requireStaff } from '../middleware/auth.js';
import { generateCopy, renderCreative, FORMATS, dataUri } from '../integrations/ai/index.js';
import { getSettings } from '../services/settings.js';
import { audit } from '../services/audit.js';
import { randomToken } from '../lib/crypto.js';
import { config } from '../config.js';

const r = Router();
r.use(requireStaff);

r.get('/ai/status', perm('promotion.manage'), (_req, res) => res.json({ copyProvider: config.ai.anthropicKey ? `anthropic:${config.ai.model}` : 'template', formats: FORMATS }));

/** Generate a preview set of creatives. Nothing is displayed until an approver approves it. */
r.post('/ai/generate', perm('promotion.manage'), async (req, res) => {
  const b = parse(z.object({
    promotionId: zOptUuid, name: z.string().trim().min(1).max(120), description: z.string().max(500).optional(), price: z.number().min(0).optional(),
    discount: z.string().max(40).optional(), period: z.string().max(80).optional(), productMediaId: zOptUuid, language: z.enum(['th', 'en', 'zh']).default('th'),
    formats: z.array(z.enum(['tv', 'display', 'social', 'motion'])).min(1).default(['tv', 'display', 'social', 'motion']),
  }), req.body);
  const s = await getSettings(req.ctx.branchId);
  const promo = b.promotionId ? await one({ query }, 'SELECT * FROM promotions WHERE id = $1', [b.promotionId]) : null;
  const { provider, copy, fallbackReason } = await generateCopy({ ...b, appliesTo: promo?.applies_to, storeName: s.general.storeName });
  const logoRow = s.branding.logoMediaId ? await one({ query }, 'SELECT * FROM media WHERE id = $1', [s.branding.logoMediaId]) : null;
  const productRow = b.productMediaId ? await one({ query }, `SELECT * FROM media WHERE id = $1 AND kind = 'IMAGE'`, [b.productMediaId]) : null;
  const assets = { logo: dataUri(logoRow), product: dataUri(productRow) };
  const out = await tx(async (db) => {
    const ids = [];
    for (const fmt of b.formats) {
      const svg = renderCreative(fmt, { copy, lang: b.language, colors: s.theme, font: s.fonts.signage?.family || 'Kanit', ...assets });
      const filename = `gen-${Date.now()}-${randomToken(6)}-${fmt}.svg`;
      fs.mkdirSync(config.uploadDir, { recursive: true });
      fs.writeFileSync(path.join(config.uploadDir, filename), svg);
      const m = await one(db, `INSERT INTO media(kind, category, filename, original_name, mime, size, url, status, generated, uploaded_by, meta) VALUES ('IMAGE','PROMOTION',$1,$2,'image/svg+xml',$3,$4,'PENDING_APPROVAL',true,$5,$6) RETURNING *`,
        [filename, `${b.name} — ${FORMATS[fmt].label}`, Buffer.byteLength(svg), `/uploads/${filename}`, req.ctx.staff.id, { format: fmt, width: FORMATS[fmt].w, height: FORMATS[fmt].h, language: b.language, provider }]);
      ids.push(m.id);
    }
    const gen = await one(db, `INSERT INTO ai_generations(promotion_id, provider, input, output, media_ids, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.promotionId || null, provider, b, { copy, fallbackReason }, ids, req.ctx.staff.id]);
    await audit(db, req.ctx, { action: 'AI_PROMOTION_GENERATE', targetType: 'ai_generation', targetId: gen.id, targetLabel: b.name, newData: { provider, formats: b.formats } });
    return gen;
  });
  const media = await many({ query }, 'SELECT * FROM media WHERE id = ANY($1)', [out.media_ids]);
  res.status(201).json({ generation: out, media, copy, provider, fallbackReason });
});

r.get('/ai/generations', perm('promotion.manage'), async (_req, res) => {
  res.json({ items: await many({ query }, `SELECT g.*, s.first_name AS created_by_name, (SELECT json_agg(m.*) FROM media m WHERE m.id = ANY(g.media_ids)) AS media FROM ai_generations g LEFT JOIN staff s ON s.id = g.created_by ORDER BY g.created_at DESC LIMIT 50`) });
});

/** Approve (optionally add to a playlist) or reject a generated set. */
r.post('/ai/generations/:id/review', perm('promotion.approve_media'), async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['APPROVED', 'REJECTED']), playlistId: zOptUuid, durationSec: z.number().int().min(3).max(600).default(10) }), req.body);
  const out = await tx(async (db) => {
    const g = await one(db, 'SELECT * FROM ai_generations WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!g) throw fail('NOT_FOUND');
    if (g.status !== 'PREVIEW') throw fail('CONFLICT', `Already ${g.status}`);
    await db.query(`UPDATE media SET status = $2, approved_by = $3, approved_at = now() WHERE id = ANY($1)`, [g.media_ids, b.decision, req.ctx.staff.id]);
    await db.query('UPDATE ai_generations SET status = $2, reviewed_by = $3 WHERE id = $1', [g.id, b.decision, req.ctx.staff.id]);
    if (b.decision === 'APPROVED' && b.playlistId) {
      for (const [i, mid] of g.media_ids.entries()) {
        await db.query(`INSERT INTO display_items(playlist_id, item_type, media_id, duration_sec, sort) VALUES ($1,'IMAGE',$2,$3,$4)`, [b.playlistId, mid, b.durationSec, 1000 + i]);
      }
    }
    if (b.decision === 'APPROVED' && g.promotion_id) await db.query('UPDATE promotions SET media_id = coalesce(media_id, $2) WHERE id = $1', [g.promotion_id, g.media_ids[0]]);
    await audit(db, req.ctx, { action: `AI_PROMOTION_${b.decision}`, targetType: 'ai_generation', targetId: g.id, newData: { playlistId: b.playlistId } });
    return { ok: true };
  });
  res.json(out);
});

export default r;
