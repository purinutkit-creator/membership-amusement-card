// Public ID generation (separate from internal UUIDs).
// TXN202610100001, RCP202610100001, MBR000012 ...
import { randomDigits } from './crypto.js';

export async function nextCounter(db, key) {
  const { rows } = await db.query(
    `INSERT INTO counters(key, value) VALUES ($1, 1)
     ON CONFLICT (key) DO UPDATE SET value = counters.value + 1 RETURNING value`,
    [key]
  );
  return Number(rows[0].value);
}

export function ymd(date = new Date(), tz = 'Asia/Bangkok') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  return parts.replace(/-/g, '');
}

/** Daily-sequenced public number: PREFIX + YYYYMMDD + 4+ digit sequence */
export async function dailyNo(db, prefix, scope = '') {
  const day = ymd();
  const n = await nextCounter(db, `${prefix}:${scope}:${day}`);
  return `${prefix}${day}${String(n).padStart(4, '0')}`;
}

export async function memberCode(db) {
  const n = await nextCounter(db, 'MBR');
  return `MBR${String(n).padStart(6, '0')}`;
}

/** Luhn check digit so mistyped card numbers are caught early. */
export function luhnDigit(base) {
  let sum = 0;
  const digits = base.split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i++) {
    let d = digits[i];
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}

export function isValidCardNumber(num) {
  return typeof num === 'string' && /^[0-9]{12}$/.test(num);
}

/** Generate a random 12-digit card number with optional prefix and Luhn check digit. */
export function generateCardNumber(prefix = '', length = 12) {
  const body = prefix + randomDigits(length - 1 - prefix.length);
  return body + luhnDigit(body);
}
