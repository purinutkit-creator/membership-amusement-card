import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const N = 16384, r = 8, p = 1, KEYLEN = 64;

/** Hash a password / PIN with scrypt + per-hash random salt. */
export async function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(secret), salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifySecret(secret, stored) {
  if (!stored || secret == null) return false;
  const [algo, n, rr, pp, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(String(secret), Buffer.from(saltB64, 'base64'), expected.length, { N: +n, r: +rr, p: +pp });
  return crypto.timingSafeEqual(key, expected);
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export function randomDigits(len) {
  let s = '';
  while (s.length < len) s += crypto.randomInt(0, 10).toString();
  return s;
}
/** Unambiguous uppercase code for redemption etc. */
export function randomCode(len = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[crypto.randomInt(0, alphabet.length)];
  return s;
}
export function hmac(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
