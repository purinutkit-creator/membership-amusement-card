// AI Promotion Generator.
// 1) Copywriting: Claude (when ANTHROPIC_API_KEY is configured) writes headline / subtitle / CTA
//    in th / en / zh via structured output. Without a key — or on any failure/refusal — a
//    deterministic template writer is used and the result says so (provider: "template").
// 2) Creative rendering: copy + brand colours + logo + product image are rendered into SVG
//    creatives for TV (16:9), customer display (9:16), social (1:1) and an animated motion
//    banner. Everything is saved as PENDING_APPROVAL media: nothing is shown until approved.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../../config.js';
import { escapeHtml } from '../../lib/html.js';
import { logger } from '../../lib/logger.js';

const CopySchema = z.object({
  th: z.object({ headline: z.string(), subtitle: z.string(), cta: z.string() }),
  en: z.object({ headline: z.string(), subtitle: z.string(), cta: z.string() }),
  zh: z.object({ headline: z.string(), subtitle: z.string(), cta: z.string() }),
  badge: z.string(),
});

const fmtMoney = (n) => `฿${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

export function templateCopy(input) {
  const offer = input.discount ? input.discount : input.price ? fmtMoney(input.price) : '';
  const period = input.period ? ` · ${input.period}` : '';
  return {
    th: { headline: input.name, subtitle: `${offer ? `${offer} ` : ''}${input.description || 'โปรโมชั่นพิเศษสำหรับคุณ'}${period}`.trim(), cta: 'แตะบัตรหรือสอบถามพนักงานได้เลย' },
    en: { headline: input.name, subtitle: `${offer ? `${offer} ` : ''}${input.descriptionEn || 'A special deal just for you'}${period}`.trim(), cta: 'Ask our staff or tap your card' },
    zh: { headline: input.name, subtitle: `${offer ? `${offer} ` : ''}专属优惠${period}`.trim(), cta: '请咨询工作人员或刷卡' },
    badge: input.discount || (input.price ? fmtMoney(input.price) : 'PROMO'),
  };
}

async function claudeCopy(input) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
  const client = new Anthropic({ apiKey: config.ai.anthropicKey });
  const response = await client.messages.parse({
    model: config.ai.model,
    max_tokens: 2000,
    output_config: { effort: 'low', format: zodOutputFormat(CopySchema) },
    system: 'You write short, punchy, family-friendly promotional copy for an amusement arcade / theme park / food park. Headline max 6 words, subtitle max 14 words, CTA max 5 words. Thai must sound natural to Thai customers; Chinese is Simplified. Never invent prices, dates or terms that are not in the brief. badge is a very short label (max 10 characters) such as "+20% BONUS" or "฿99".',
    messages: [{ role: 'user', content: `Promotion brief (JSON):\n${JSON.stringify({ name: input.name, description: input.description, price: input.price, discount: input.discount, period: input.period, appliesTo: input.appliesTo, storeName: input.storeName })}` }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Model declined the request');
  if (!response.parsed_output) throw new Error('No structured output returned');
  return response.parsed_output;
}

export async function generateCopy(input) {
  if (config.ai.anthropicKey) {
    try {
      return { provider: `anthropic:${config.ai.model}`, copy: await claudeCopy(input) };
    } catch (e) {
      logger.warn('ai.copy_failed_fallback_template', { message: e.message });
      return { provider: 'template', fallbackReason: e.message, copy: templateCopy(input) };
    }
  }
  return { provider: 'template', copy: templateCopy(input) };
}

function dataUri(file) {
  if (!file) return null;
  try {
    const buf = fs.readFileSync(path.join(config.uploadDir, file.filename));
    if (buf.length > 3 * 1024 * 1024) return null;
    return `data:${file.mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

const FORMATS = {
  tv: { w: 1920, h: 1080, label: 'TV Banner 16:9' },
  display: { w: 1080, h: 1920, label: 'Customer Display 9:16' },
  social: { w: 1080, h: 1080, label: 'Social Post 1:1' },
  motion: { w: 1920, h: 1080, label: 'Motion Banner (animated)', animated: true },
};

/** Render one SVG creative. lang: th|en|zh. */
export function renderCreative(format, { copy, lang = 'th', colors, logo, product, font = 'Kanit' }) {
  const f = FORMATS[format];
  const c = copy[lang] || copy.th;
  const { w, h } = f;
  const portrait = h > w;
  const s = Math.min(w, h) / 1080;
  const primary = colors.primary || '#6D28D9';
  const secondary = colors.secondary || '#0EA5E9';
  const accent = colors.accent || '#F59E0B';
  const textX = portrait ? w / 2 : w * 0.07;
  const anchor = portrait ? 'middle' : 'start';
  const headY = portrait ? h * 0.58 : h * 0.42;
  const imgBox = portrait ? { x: w * 0.15, y: h * 0.12, w: w * 0.7, h: w * 0.7 } : { x: w * 0.56, y: h * 0.14, w: w * 0.38, h: h * 0.72 };
  const anim = f.animated
    ? `<style>
        .a1{animation:up 1s ease-out both}.a2{animation:up 1s .3s ease-out both}.a3{animation:up 1s .6s ease-out both}
        .pulse{animation:pulse 1.6s 1.2s ease-in-out infinite;transform-origin:center;transform-box:fill-box}
        .float{animation:float 4s ease-in-out infinite;transform-box:fill-box}
        .shine{animation:shine 3s linear infinite}
        @keyframes up{from{opacity:0;transform:translateY(60px)}to{opacity:1;transform:none}}
        @keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}
        @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-24px)}}
        @keyframes shine{from{transform:translateX(-${w}px)}to{transform:translateX(${w}px)}}
      </style>` : '';
  const wrap = (text, max) => {
    const words = String(text).split(/\s+/); const lines = []; let cur = '';
    for (const word of words) { if ((cur + ' ' + word).trim().length > max && cur) { lines.push(cur); cur = word; } else cur = (cur + ' ' + word).trim(); }
    if (cur) lines.push(cur);
    return lines.slice(0, 3);
  };
  const headLines = wrap(c.headline, portrait ? 16 : 20);
  const subLines = wrap(c.subtitle, portrait ? 30 : 42);
  const headSize = 96 * s; const subSize = 44 * s;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
${anim}
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${escapeHtml(primary)}"/><stop offset="1" stop-color="${escapeHtml(secondary)}"/></linearGradient>
  <linearGradient id="sh" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".18"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <clipPath id="imgclip"><rect x="${imgBox.x}" y="${imgBox.y}" width="${imgBox.w}" height="${imgBox.h}" rx="${40 * s}"/></clipPath>
</defs>
<rect width="${w}" height="${h}" fill="url(#bg)"/>
<circle cx="${w * 0.9}" cy="${h * 0.1}" r="${260 * s}" fill="#fff" opacity=".08" class="${f.animated ? 'float' : ''}"/>
<circle cx="${w * 0.05}" cy="${h * 0.95}" r="${320 * s}" fill="#000" opacity=".08"/>
${f.animated ? `<rect class="shine" x="0" y="0" width="${w * 0.4}" height="${h}" fill="url(#sh)"/>` : ''}
${product ? `<g class="${f.animated ? 'float' : ''}"><rect x="${imgBox.x}" y="${imgBox.y}" width="${imgBox.w}" height="${imgBox.h}" rx="${40 * s}" fill="#fff" opacity=".15"/><image href="${product}" x="${imgBox.x}" y="${imgBox.y}" width="${imgBox.w}" height="${imgBox.h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#imgclip)"/></g>` : ''}
${logo ? `<image href="${logo}" x="${portrait ? w / 2 - 110 * s : w * 0.07}" y="${40 * s}" width="${220 * s}" height="${110 * s}" preserveAspectRatio="xMinYMid meet"/>` : ''}
<g font-family="${escapeHtml(font)}, 'Noto Sans Thai', 'Noto Sans SC', sans-serif" fill="#fff" text-anchor="${anchor}">
  <g class="${f.animated ? 'a1' : ''}">${headLines.map((l, i) => `<text x="${textX}" y="${headY + i * headSize * 1.1}" font-size="${headSize}" font-weight="800">${escapeHtml(l)}</text>`).join('')}</g>
  <g class="${f.animated ? 'a2' : ''}">${subLines.map((l, i) => `<text x="${textX}" y="${headY + headLines.length * headSize * 1.1 + 20 * s + i * subSize * 1.3}" font-size="${subSize}" opacity=".95">${escapeHtml(l)}</text>`).join('')}</g>
  <g class="${f.animated ? 'a3 pulse' : ''}">
    <rect x="${portrait ? w / 2 - 300 * s : textX}" y="${h - (portrait ? 260 : 210) * s}" width="${600 * s}" height="${110 * s}" rx="${55 * s}" fill="${escapeHtml(accent)}"/>
    <text x="${portrait ? w / 2 : textX + 300 * s}" y="${h - (portrait ? 190 : 140) * s}" font-size="${44 * s}" font-weight="700" text-anchor="middle" fill="#111">${escapeHtml(c.cta)}</text>
  </g>
</g>
<g class="${f.animated ? 'pulse' : ''}"><circle cx="${portrait ? w * 0.82 : w * 0.52}" cy="${portrait ? h * 0.52 : h * 0.2}" r="${120 * s}" fill="${escapeHtml(accent)}"/>
<text x="${portrait ? w * 0.82 : w * 0.52}" y="${(portrait ? h * 0.52 : h * 0.2) + 16 * s}" font-family="${escapeHtml(font)}, sans-serif" font-size="${46 * s}" font-weight="800" text-anchor="middle" fill="#111">${escapeHtml(copy.badge || '')}</text></g>
</svg>`;
}

export { FORMATS, dataUri };
