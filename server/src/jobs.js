// Background housekeeping. Each job is idempotent and safe to run on several instances.
import { query, many, tx } from './db/pool.js';
import { logger } from './lib/logger.js';
import { getSettings } from './services/settings.js';
import { lockCard, postEntry } from './services/ledger.js';
import { expireStalePayments } from './services/orders.js';
import { grantBirthdayRewards } from './services/members.js';
import { notify } from './services/notifications.js';
import { emit } from './realtime.js';

export async function markOfflineDevices() {
  const s = await getSettings();
  const { rows } = await query(`UPDATE devices SET online = false WHERE online AND last_online_at < now() - ($1 || ' seconds')::interval RETURNING id`, [String(s.device.offlineAfterSec)]);
  for (const d of rows) {
    const ms = (await query('UPDATE machines SET online = false WHERE device_id = $1 AND online RETURNING id, name', [d.id])).rows;
    for (const m of ms) {
      emit(['staff'], 'machine:update', { machineId: m.id, online: false });
      if (s.notification.machineOffline) await notify({ query }, { audience: 'ALL_STAFF', type: 'MACHINE_OFFLINE', title: `Machine offline: ${m.name}`, data: { machineId: m.id } });
    }
  }
  return rows.length;
}

/** Expire cards past expires_at; optionally forfeit remaining balance via ledger (BALANCE_EXPIRE). */
export async function expireCards() {
  const s = await getSettings();
  const due = await many({ query }, `SELECT id FROM cards WHERE status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at < now() LIMIT 500`);
  for (const { id } of due) {
    await tx(async (db) => {
      const card = await lockCard(db, id);
      if (card.status !== 'ACTIVE') return;
      if (s.card.expiredBalancePolicy === 'FORFEIT' && Number(card.balance) > 0) {
        await postEntry(db, card, { type: 'BALANCE_EXPIRE', amount: -Number(card.balance), reason: 'Card expired — balance forfeited per policy' });
      }
      await db.query(`UPDATE cards SET status = 'EXPIRED' WHERE id = $1`, [id]);
    });
  }
  return due.length;
}

/** Points/stamps expire after N months of card inactivity (when configured). */
export async function expireLoyalty() {
  const s = await getSettings();
  let n = 0;
  for (const [field, months, type] of [['points', s.point.expiryMonths, 'POINT_EXPIRE'], ['stamps', s.stamp.expiryMonths, 'STAMP_EXPIRE']]) {
    if (!(months > 0)) continue;
    const due = await many({ query }, `SELECT id FROM cards WHERE ${field} > 0 AND coalesce(last_used_at, issued_at) < now() - ($1 || ' months')::interval LIMIT 500`, [String(months)]);
    for (const { id } of due) {
      await tx(async (db) => {
        const card = await lockCard(db, id);
        await postEntry(db, card, { type, [field]: -card[field], reason: `Expired after ${months} months of inactivity` });
      });
      n++;
    }
  }
  return n;
}

export function startJobs() {
  const run = (name, fn) => fn().then((n) => n && logger.info(`job.${name}`, { affected: n })).catch((e) => logger.error(`job.${name}_failed`, { message: e.message }));
  const every = (ms, name, fn) => setInterval(() => run(name, fn), ms).unref();
  every(30_000, 'devices_offline', markOfflineDevices);
  every(5 * 60_000, 'expire_payments', expireStalePayments);
  every(60 * 60_000, 'expire_cards', expireCards);
  every(6 * 60 * 60_000, 'expire_loyalty', expireLoyalty);
  every(60 * 60_000, 'birthday_rewards', () => tx((db) => grantBirthdayRewards(db)));
  run('expire_cards', expireCards);
}
