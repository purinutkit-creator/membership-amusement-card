// Currency helpers. All amounts are rounded to 2 decimals (satang precision).
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const toSatang = (n) => Math.round(Number(n) * 100);
export const fromSatang = (s) => s / 100;
export const sum = (arr) => fromSatang(arr.reduce((a, n) => a + toSatang(n), 0));
export const sub = (a, b) => fromSatang(toSatang(a) - toSatang(b));
export const add = (a, b) => fromSatang(toSatang(a) + toSatang(b));
export const pct = (amount, rate) => round2((Number(amount) * Number(rate)) / 100);
export const fmt = (n, currency = '฿') => `${currency}${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
