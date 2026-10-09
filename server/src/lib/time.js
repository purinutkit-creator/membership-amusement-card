/** Wall-clock parts in a timezone: dow (0=Sun), minutes since midnight, month (1-12), ymd. */
export function localParts(date = new Date(), tz = 'Asia/Bangkok') {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const dows = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(p.hour) % 24;
  return { dow: dows[p.weekday], minutes: hour * 60 + Number(p.minute), month: Number(p.month), ymd: `${p.year}-${p.month}-${p.day}` };
}

export const toMinutes = (hhmm) => {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
};

/** True if `minutes` falls in [start, end) — handles windows crossing midnight. */
export function inTimeWindow(minutes, start, end) {
  const s = toMinutes(start); const e = toMinutes(end);
  if (s == null || e == null) return true;
  return s <= e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}
