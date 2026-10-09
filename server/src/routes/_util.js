import { one, many, query } from '../db/pool.js';
import { parse, zPage } from '../lib/validate.js';

/** Paginated query. `sql` must not include ORDER/LIMIT. */
export async function paginate(sql, params, q, orderBy = 'created_at DESC') {
  const { page, pageSize } = parse(zPage, q);
  const total = (await one({ query }, `SELECT count(*)::int AS n FROM (${sql}) x`, params)).n;
  const items = await many({ query }, `${sql} ORDER BY ${orderBy} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
  return { items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Small WHERE builder: w.add('col = $?', value) */
export function where() {
  const parts = []; const params = [];
  return {
    params,
    add(clause, ...vals) {
      let c = clause;
      for (const v of vals) { params.push(v); c = c.replace('$?', `$${params.length}`); }
      parts.push(c);
      return this;
    },
    sql() { return parts.length ? `WHERE ${parts.join(' AND ')}` : ''; },
  };
}

/** Date range filter presets for reports. */
export function dateRange(q, tz = 'Asia/Bangkok') {
  const now = new Date();
  const fmt = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  const today = fmt(now);
  const add = (ymd, days) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  let from = today, to = today;
  switch (q.range) {
    case 'yesterday': from = to = add(today, -1); break;
    case 'week': { const dow = new Date(today + 'T00:00:00Z').getUTCDay(); from = add(today, -((dow + 6) % 7)); to = today; break; }
    case 'month': from = today.slice(0, 8) + '01'; to = today; break;
    case 'last30': from = add(today, -29); to = today; break;
    case 'custom': from = q.from || today; to = q.to || today; break;
    default: if (q.from) { from = q.from; to = q.to || today; }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) { from = to = today; }
  // timestamptz bounds in the business timezone
  return { from, to, start: `${from}T00:00:00`, end: `${add(to, 1)}T00:00:00`, tz };
}

export { one, many, query };
