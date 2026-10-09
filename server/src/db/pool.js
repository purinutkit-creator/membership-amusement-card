import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// NUMERIC -> JS number (values are 2-decimal currency well inside safe range)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// INT8 (counts) -> number
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// DATE -> keep as 'YYYY-MM-DD' string (no timezone shifting)
pg.types.setTypeParser(1082, (v) => v);

// Managed hosts' external URLs (e.g. *.render.com) require TLS; internal URLs and local DBs do not.
const needsSsl = process.env.DB_SSL ? process.env.DB_SSL === 'true' : /\.render\.com[:/]/.test(config.databaseUrl);
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.DB_POOL_MAX || 20),
  ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});
pool.on('error', (err) => logger.error('db.pool_error', { message: err.message }));

export function query(text, params) {
  return pool.query(text, params);
}

/** Run fn inside a DB transaction. Rolls back everything on error. */
export async function tx(fn) {
  const client = await pool.connect();
  const hooks = [];
  client.afterCommit = (hook) => hooks.push(hook);
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    for (const h of hooks) {
      try { await h(); } catch (e) { logger.error('db.after_commit_hook_failed', { message: e.message }); }
    }
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    delete client.afterCommit;
    client.release();
  }
}

export async function one(db, text, params) {
  const { rows } = await db.query(text, params);
  return rows[0] || null;
}
export async function many(db, text, params) {
  const { rows } = await db.query(text, params);
  return rows;
}

/** Register a hook on a tx client, or run immediately when not in a tx. */
export function afterCommit(db, hook) {
  if (db && typeof db.afterCommit === 'function') db.afterCommit(hook);
  else Promise.resolve().then(hook).catch((e) => logger.error('db.after_commit_hook_failed', { message: e.message }));
}
