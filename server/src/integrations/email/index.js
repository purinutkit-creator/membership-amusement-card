// Email adapter. Configure EMAIL_PROVIDER=webhook + EMAIL_WEBHOOK_URL to relay to your mail service
// (SendGrid/SES/etc. via a small function), or 'console' in development. Default: disabled.
import { config } from '../../config.js';

const provider = process.env.EMAIL_PROVIDER || (config.isProd ? 'none' : 'console');

export function emailConfigured() { return provider !== 'none'; }

export async function sendEmail({ to, subject, html, text }) {
  if (provider === 'console') { process.stdout.write(`[DEV EMAIL] to=${to} subject=${subject}\n`); return { ok: true, provider }; }
  if (provider === 'webhook') {
    const r = await fetch(process.env.EMAIL_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.EMAIL_WEBHOOK_TOKEN || ''}` }, body: JSON.stringify({ to, subject, html, text }), signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`Email relay failed (${r.status})`);
    return { ok: true, provider };
  }
  throw new Error('Email is not configured');
}
