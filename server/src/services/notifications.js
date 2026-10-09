import { one, afterCommit } from '../db/pool.js';
import { emit } from '../realtime.js';

/** Persist a notification and push it in realtime after commit. */
export async function notify(db, { audience = 'ALL_STAFF', staffId, memberId, branchId, type, title, body, data = {} }) {
  const n = await one(db,
    `INSERT INTO notifications(audience, staff_id, member_id, branch_id, type, title, body, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [audience, staffId || null, memberId || null, branchId || null, type, title, body || null, data]);
  const rooms = audience === 'MEMBER' ? [`member:${memberId}`]
    : audience === 'STAFF' ? [`staff:${staffId}`]
    : audience === 'BRANCH' ? [`branch:${branchId}`] : ['staff'];
  afterCommit(db, () => emit(rooms, 'notification:new', n));
  return n;
}
