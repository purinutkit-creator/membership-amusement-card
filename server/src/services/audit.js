import { query } from '../db/pool.js';

/**
 * Write an audit log entry. `ctx` is the request context (actor/device/ip).
 * Pass a DB client as `db` to make the log part of the same transaction.
 */
export async function audit(db, ctx, { action, targetType, targetId, targetLabel, oldData, newData, reason, approverId }) {
  const actor = ctx?.staff || ctx?.member || null;
  await (db || { query }).query(
    `INSERT INTO audit_logs(actor_type, actor_id, actor_name, actor_role, action, target_type, target_id, target_label,
       old_data, new_data, reason, approver_id, device_id, ip, branch_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      ctx?.staff ? 'STAFF' : ctx?.member ? 'MEMBER' : ctx?.device ? 'DEVICE' : 'SYSTEM',
      actor?.id || null,
      ctx?.staff ? `${ctx.staff.first_name} ${ctx.staff.last_name || ''}`.trim() : ctx?.member ? `${ctx.member.first_name} ${ctx.member.last_name || ''}`.trim() : ctx?.device?.name || 'system',
      ctx?.staff?.role_code || (ctx?.member ? 'MEMBER' : null),
      action,
      targetType || null,
      targetId != null ? String(targetId) : null,
      targetLabel || null,
      oldData ? JSON.stringify(stripSecrets(oldData)) : null,
      newData ? JSON.stringify(stripSecrets(newData)) : null,
      reason || null,
      approverId || null,
      ctx?.device?.id || null,
      ctx?.ip || null,
      ctx?.branchId || null,
    ]
  );
}

function stripSecrets(o) {
  if (!o || typeof o !== 'object') return o;
  const out = Array.isArray(o) ? [] : {};
  for (const [k, v] of Object.entries(o)) {
    if (/hash|password|pin|token|secret/i.test(k)) continue;
    out[k] = v && typeof v === 'object' && !(v instanceof Date) ? stripSecrets(v) : v;
  }
  return out;
}
