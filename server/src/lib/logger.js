// Structured JSON logger. Never pass passwords, PINs, tokens or payment secrets.
const REDACT = /pass(word)?|pin|secret|token|cvv|authorization|cookie/i;

function scrub(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = REDACT.test(k) ? '[REDACTED]' : scrub(v, depth + 1);
  return out;
}

function write(level, category, event, data) {
  if (process.env.NODE_ENV === 'test' && level !== 'error' && !process.env.LOG_TESTS) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, category, event, ...scrub(data || {}) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

const make = (category) => ({
  info: (e, d) => write('info', category, e, d),
  warn: (e, d) => write('warn', category, e, d),
  error: (e, d) => write('error', category, e, d),
});

export const logger = {
  ...make('system'),
  payment: make('payment'),
  device: make('device'),
  security: make('security'),
  system: make('system'),
};
