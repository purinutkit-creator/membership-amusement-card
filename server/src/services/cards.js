import { query, one, many, afterCommit } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { generateCardNumber, isValidCardNumber, dailyNo } from '../lib/ids.js';
import { randomToken } from '../lib/crypto.js';
import { lockCard, lockCards, postEntry, postInfoEntry } from './ledger.js';
import { getSettings } from './settings.js';
import { audit } from './audit.js';
import { emit } from '../realtime.js';
import { notify } from './notifications.js';

const UNUSABLE = { BLOCKED: 'CARD_BLOCKED', LOST: 'CARD_LOST', EXPIRED: 'CARD_EXPIRED', REPLACED: 'CARD_REPLACED', INACTIVE: 'CARD_INACTIVE' };

/**
 * Resolve any card identifier: 12-digit number (typed / barcode), RFID/NFC UID from a reader,
 * or a Card QR (portal URL containing a secure token, or the bare token).
 */
export async function findCard(db, identifier) {
  if (!identifier) throw fail('CARD_NOT_FOUND');
  const raw = String(identifier).trim();
  const digits = raw.replace(/[\s-]/g, '');
  let card = null;
  if (/^[0-9]{12}$/.test(digits)) card = await one(db, 'SELECT * FROM cards WHERE card_number = $1', [digits]);
  if (!card) {
    const m = raw.match(/\/c\/([A-Za-z0-9_-]{16,})/);
    const token = m ? m[1] : /^[A-Za-z0-9_-]{20,}$/.test(raw) ? raw : null;
    if (token) {
      card = await one(db, `SELECT c.* FROM qr_tokens q JOIN cards c ON c.id = q.target_id
        WHERE q.token = $1 AND q.kind = 'CARD_PORTAL' AND q.revoked_at IS NULL AND (q.expires_at IS NULL OR q.expires_at > now())`, [token]);
    }
  }
  if (!card) card = await one(db, 'SELECT * FROM cards WHERE rfid_uid = $1', [raw.toUpperCase()]);
  if (!card) throw fail('CARD_NOT_FOUND');
  return card;
}

export async function getCardById(db, id) {
  const c = await one(db, 'SELECT * FROM cards WHERE id = $1', [id]);
  if (!c) throw fail('CARD_NOT_FOUND');
  return c;
}

/** Throw the precise error for a card that cannot transact. Marks expired cards. */
export async function assertUsable(db, card) {
  if (card.status === 'ACTIVE' && card.expires_at && new Date(card.expires_at) <= new Date()) {
    await db.query(`UPDATE cards SET status = 'EXPIRED' WHERE id = $1 AND status = 'ACTIVE'`, [card.id]);
    card.status = 'EXPIRED';
  }
  if (card.status !== 'ACTIVE') throw fail(UNUSABLE[card.status] || 'CARD_BLOCKED');
  if (card.member_id) {
    const m = await one(db, 'SELECT status FROM members WHERE id = $1', [card.member_id]);
    if (m && m.status !== 'ACTIVE') throw fail('MEMBER_SUSPENDED');
  }
  return card;
}

export function computeExpiry(cardSettings, from = new Date()) {
  const e = cardSettings.expiration || { mode: 'NONE' };
  if (e.mode === 'DAYS' && e.value > 0) return new Date(from.getTime() + e.value * 86400000);
  if (e.mode === 'MONTHS' && e.value > 0) { const d = new Date(from); d.setMonth(d.getMonth() + Number(e.value)); return d; }
  if (e.mode === 'DATE' && e.date) return new Date(e.date + 'T23:59:59+07:00');
  return null;
}

/** Create card stock. Either explicit numbers (manual/import) or `count` auto-generated. */
export async function createCards(db, ctx, { numbers, count, cardType = 'MEMBER', prefix, rfidUids = {}, note, branchId }) {
  const s = await getSettings(branchId);
  const pfx = prefix ?? s.card.prefix ?? '';
  if (!/^[0-9]{0,6}$/.test(pfx)) throw fail('VALIDATION_ERROR', 'Card prefix must be up to 6 digits');
  const list = [];
  if (numbers?.length) {
    for (const n of numbers) {
      const num = String(n).trim();
      if (!isValidCardNumber(num)) throw fail('VALIDATION_ERROR', `Invalid card number "${num}" — must be exactly 12 digits`);
      list.push(num);
    }
    if (new Set(list).size !== list.length) throw fail('CONFLICT', 'Duplicate card numbers in input');
  } else {
    if (!count || count < 1 || count > 5000) throw fail('VALIDATION_ERROR', 'Count must be 1-5000');
  }
  const batch = (numbers?.length || 0) + (count || 0) > 1
    ? await one(db, 'INSERT INTO card_batches(batch_no, quantity, card_type, prefix, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [await dailyNo(db, 'BAT'), numbers?.length || count, cardType, pfx, note || null, ctx.staff?.id || null])
    : null;
  const created = [];
  const insert = async (num) => one(db,
    `INSERT INTO cards(card_number, rfid_uid, card_type, status, batch_id, branch_id) VALUES ($1,$2,$3,'INACTIVE',$4,$5)
     ON CONFLICT DO NOTHING RETURNING *`,
    [num, rfidUids[num] ? String(rfidUids[num]).toUpperCase() : null, cardType, batch?.id || null, branchId || ctx.branchId || null]);
  if (numbers?.length) {
    const existing = await many(db, 'SELECT card_number FROM cards WHERE card_number = ANY($1)', [list]);
    if (existing.length) throw fail('CONFLICT', `Card number already exists: ${existing.map((e) => e.card_number).join(', ')}`);
    for (const n of list) {
      const c = await insert(n);
      if (!c) throw fail('CONFLICT', `Card number or RFID already exists: ${n}`);
      created.push(c);
    }
  } else {
    let guard = 0;
    while (created.length < count) {
      if (++guard > count * 20) throw fail('CONFLICT', 'Could not allocate unique card numbers — widen the prefix space');
      const c = await insert(generateCardNumber(pfx, 12));
      if (c) created.push(c); // collision -> retry with a new random number
    }
  }
  await audit(db, ctx, { action: 'CARD_CREATE', targetType: 'card_batch', targetId: batch?.id || created[0]?.id, targetLabel: batch?.batch_no || created[0]?.card_number, newData: { count: created.length, cardType } });
  return { batch, cards: created };
}

export async function ensurePortalToken(db, cardId, rotate = false) {
  if (rotate) await db.query(`UPDATE qr_tokens SET revoked_at = now() WHERE kind = 'CARD_PORTAL' AND target_id = $1 AND revoked_at IS NULL`, [cardId]);
  const existing = !rotate && await one(db, `SELECT token FROM qr_tokens WHERE kind = 'CARD_PORTAL' AND target_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [cardId]);
  if (existing) return existing.token;
  const token = randomToken(24);
  await db.query(`INSERT INTO qr_tokens(token, kind, target_id) VALUES ($1, 'CARD_PORTAL', $2)`, [token, cardId]);
  return token;
}

/**
 * Activate (issue) an INACTIVE card to a member or as a guest card.
 * Deposit is recorded as a ledgered CARD_DEPOSIT entry (cash, not wallet balance).
 */
export async function issueCard(db, ctx, { cardId, memberId, cardType, deposit = 0, orderId, paymentId, rfidUid, waiveReason }) {
  const card = await lockCard(db, cardId);
  if (card.status !== 'INACTIVE') throw fail('CARD_IN_USE', `Card ${card.card_number} is ${card.status}`);
  if (Number(card.balance) !== 0) throw fail('CONFLICT', 'Card still holds balance from a previous holder');
  const s = await getSettings(ctx.branchId);
  const type = memberId ? 'MEMBER' : (cardType || 'GUEST');
  if (type === 'GUEST' && !s.card.guestCardEnabled) throw fail('FORBIDDEN', 'Guest cards are disabled');
  if (memberId) {
    const m = await one(db, 'SELECT id, status FROM members WHERE id = $1', [memberId]);
    if (!m) throw fail('MEMBER_NOT_FOUND');
    if (m.status !== 'ACTIVE') throw fail('MEMBER_SUSPENDED');
  }
  if (rfidUid) {
    const dup = await one(db, 'SELECT id FROM cards WHERE rfid_uid = $1 AND id <> $2', [rfidUid.toUpperCase(), card.id]);
    if (dup) throw fail('CONFLICT', 'RFID UID is already linked to another card');
  }
  const updated = await one(db,
    `UPDATE cards SET status = 'ACTIVE', card_type = $2, member_id = $3, issued_at = now(), issued_by = $4,
       expires_at = $5, deposit_amount = $6, branch_id = coalesce(branch_id, $7), rfid_uid = coalesce($8, rfid_uid)
     WHERE id = $1 RETURNING *`,
    [card.id, type, memberId || null, ctx.staff?.id || null, computeExpiry(s.card), deposit, ctx.branchId || null, rfidUid ? rfidUid.toUpperCase() : null]);
  Object.assign(card, updated);
  if (memberId) await db.query('INSERT INTO card_members(card_id, member_id, linked_by, reason) VALUES ($1,$2,$3,$4)', [card.id, memberId, ctx.staff?.id || null, 'ISSUE']);
  const { txn } = await postInfoEntry(db, card, {
    type: 'CARD_DEPOSIT', ctx, memberId: memberId || null, orderId, paymentId, cashAmount: deposit,
    reason: waiveReason ? `Deposit waived: ${waiveReason}` : 'Card issued', meta: { deposit, waived: !!waiveReason },
  });
  await ensurePortalToken(db, card.id);
  await audit(db, ctx, { action: 'CARD_ISSUE', targetType: 'card', targetId: card.id, targetLabel: card.card_number, newData: { memberId, type, deposit }, reason: waiveReason });
  afterCommit(db, () => emit(['staff', `card:${card.id}`], 'card:update', { cardId: card.id }));
  return { card: updated, txn };
}

export async function setCardStatus(db, ctx, cardId, status, reason) {
  const card = await lockCard(db, cardId);
  const allowed = {
    BLOCKED: ['ACTIVE', 'LOST', 'EXPIRED'], LOST: ['ACTIVE', 'BLOCKED'], ACTIVE: ['BLOCKED', 'LOST', 'EXPIRED'],
  };
  if (!allowed[status]?.includes(card.status)) throw fail('CONFLICT', `Cannot change card from ${card.status} to ${status}`);
  if (status === 'ACTIVE' && card.card_type === 'MEMBER' && !card.member_id) throw fail('CONFLICT', 'Member card has no member');
  let expires = card.expires_at;
  if (status === 'ACTIVE' && card.status === 'EXPIRED') {
    const s = await getSettings(ctx.branchId);
    expires = computeExpiry(s.card);
  }
  const updated = await one(db, 'UPDATE cards SET status = $2, block_reason = $3, expires_at = $4 WHERE id = $1 RETURNING *',
    [card.id, status, status === 'ACTIVE' ? null : reason, expires]);
  await audit(db, ctx, { action: status === 'ACTIVE' ? 'CARD_UNBLOCK' : status === 'LOST' ? 'CARD_LOST' : 'CARD_BLOCK', targetType: 'card', targetId: card.id, targetLabel: card.card_number, oldData: { status: card.status }, newData: { status }, reason });
  if (status !== 'ACTIVE' && card.member_id) {
    await notify(db, { audience: 'MEMBER', memberId: card.member_id, type: 'CARD_BLOCKED', title: 'Card blocked', body: `Card ****${card.card_number.slice(-4)} was ${status.toLowerCase()}`, data: { cardId: card.id } });
  }
  afterCommit(db, () => emit(['staff', `card:${card.id}`, card.member_id && `member:${card.member_id}`], 'card:update', { cardId: card.id, status }));
  return updated;
}

/**
 * Replace a lost/damaged card: moves balance, points, stamps & deposit to a new card.
 * Old card becomes REPLACED immediately. Optional fee is deducted from the transferred balance.
 */
export async function replaceCard(db, ctx, { oldCardId, newCardId, reason, fee = 0, orderId }) {
  if (oldCardId === newCardId) throw fail('VALIDATION_ERROR', 'New card must be different');
  const locked = await lockCards(db, [oldCardId, newCardId]);
  const oldC = locked[oldCardId];
  const newC = locked[newCardId];
  if (!['ACTIVE', 'BLOCKED', 'LOST', 'EXPIRED'].includes(oldC.status)) throw fail('CONFLICT', `Card ${oldC.card_number} cannot be replaced (status ${oldC.status})`);
  if (newC.status !== 'INACTIVE' || Number(newC.balance) !== 0) throw fail('CARD_IN_USE', `Card ${newC.card_number} is not available`);
  const s = await getSettings(ctx.branchId);
  const balance = Number(oldC.balance);
  const points = oldC.points;
  const stamps = oldC.stamps;
  const ref = `${oldC.card_number}->${newC.card_number}`;

  await db.query(
    `UPDATE cards SET status = 'ACTIVE', card_type = $2, member_id = $3, issued_at = now(), issued_by = $4, expires_at = $5,
        deposit_amount = $6, replaced_from = $7, branch_id = coalesce(branch_id, $8) WHERE id = $1`,
    [newC.id, oldC.card_type, oldC.member_id, ctx.staff?.id || null, oldC.expires_at || computeExpiry(s.card), oldC.deposit_amount, oldC.id, ctx.branchId || null]);
  Object.assign(newC, await one(db, 'SELECT * FROM cards WHERE id = $1', [newC.id]));

  const out = await postEntry(db, oldC, { type: 'CARD_TRANSFER_OUT', amount: -balance, points: -points, stamps: -stamps, ctx, reason, reference: ref, meta: { toCardId: newC.id } });
  const inn = await postEntry(db, newC, { type: 'CARD_TRANSFER_IN', amount: balance, points, stamps, ctx, reason, reference: ref, meta: { fromCardId: oldC.id } });
  let feeTxn = null;
  if (fee > 0) {
    if (Number(newC.balance) < fee) throw fail('INSUFFICIENT_BALANCE', 'Balance is not enough to cover the replacement fee');
    feeTxn = (await postEntry(db, newC, { type: 'PURCHASE', amount: -fee, ctx, reason: 'Card replacement fee', reference: ref, orderId, stats: { spend: fee } })).txn;
  }
  await db.query(`UPDATE cards SET status = 'REPLACED', replaced_by = $2, block_reason = $3, deposit_amount = 0 WHERE id = $1`, [oldC.id, newC.id, reason]);
  await db.query(`UPDATE qr_tokens SET revoked_at = now() WHERE kind = 'CARD_PORTAL' AND target_id = $1 AND revoked_at IS NULL`, [oldC.id]);
  if (oldC.member_id) {
    await db.query('UPDATE card_members SET unlinked_at = now() WHERE card_id = $1 AND unlinked_at IS NULL', [oldC.id]);
    await db.query('INSERT INTO card_members(card_id, member_id, linked_by, reason) VALUES ($1,$2,$3,$4)', [newC.id, oldC.member_id, ctx.staff?.id || null, 'REPLACEMENT']);
  }
  await ensurePortalToken(db, newC.id);
  await audit(db, ctx, { action: 'CARD_REPLACE', targetType: 'card', targetId: oldC.id, targetLabel: ref, oldData: { cardNumber: oldC.card_number, balance, points, stamps, status: oldC.status }, newData: { cardNumber: newC.card_number, fee }, reason });
  afterCommit(db, () => emit(['staff', `card:${oldC.id}`, `card:${newC.id}`, oldC.member_id && `member:${oldC.member_id}`], 'card:update', { cardId: newC.id }));
  return { oldCard: { ...oldC, status: 'REPLACED' }, newCard: newC, transactions: [out.txn, inn.txn, feeTxn].filter(Boolean) };
}

/** Move part of the balance between two active cards. */
export async function transferBalance(db, ctx, { fromCardId, toCardId, amount, reason, approverId }) {
  if (fromCardId === toCardId) throw fail('VALIDATION_ERROR', 'Choose two different cards');
  const locked = await lockCards(db, [fromCardId, toCardId]);
  const from = await assertUsable(db, locked[fromCardId]);
  const to = await assertUsable(db, locked[toCardId]);
  const ref = `${from.card_number}->${to.card_number}`;
  const a = await postEntry(db, from, { type: 'CARD_TRANSFER_OUT', amount: -amount, ctx, reason, approverId, reference: ref });
  const b = await postEntry(db, to, { type: 'CARD_TRANSFER_IN', amount, ctx, reason, approverId, reference: ref });
  await audit(db, ctx, { action: 'CARD_TRANSFER', targetType: 'card', targetId: from.id, targetLabel: ref, newData: { amount }, reason, approverId });
  afterCommit(db, () => emit(['staff', `card:${from.id}`, `card:${to.id}`], 'card:update', {}));
  return [a.txn, b.txn];
}

/** Guest-card return: refund deposit (and optionally remaining balance) in cash, recycle card. */
export async function returnCard(db, ctx, { cardId, refundBalance, reason, approverId, shiftId }) {
  const card = await lockCard(db, cardId);
  if (!['ACTIVE', 'EXPIRED'].includes(card.status)) throw fail('CONFLICT', `Card is ${card.status}`);
  const s = await getSettings(ctx.branchId);
  const txns = [];
  const balance = Number(card.balance);
  if (balance > 0) {
    if (!refundBalance) throw fail('CONFLICT', `Card still has balance ฿${balance.toFixed(2)} — refund or use it first`);
    txns.push((await postEntry(db, card, { type: 'REFUND', amount: -balance, cashAmount: -balance, ctx, approverId, reason: reason || 'Card returned — balance refunded' })).txn);
  }
  const deposit = s.card.depositRefundable ? Number(card.deposit_amount) : 0;
  txns.push((await postEntry(db, card, { type: 'DEPOSIT_REFUND', points: -card.points, stamps: -card.stamps, cashAmount: -deposit, ctx, approverId, reason: reason || 'Card returned', meta: { deposit } })).txn);
  const cashOut = deposit + (refundBalance ? balance : 0);
  if (cashOut > 0) {
    await db.query(`INSERT INTO refunds(refund_no, transaction_id, amount, method, reason, staff_id, approver_id, branch_id, shift_id)
      VALUES ($1,$2,$3,'CASH',$4,$5,$6,$7,$8)`, [await dailyNo(db, 'RFD'), txns[txns.length - 1].id, cashOut, reason || 'Card returned', ctx.staff?.id || null, approverId || null, ctx.branchId || null, shiftId || null]);
  }
  if (card.member_id) await db.query('UPDATE card_members SET unlinked_at = now() WHERE card_id = $1 AND unlinked_at IS NULL', [card.id]);
  await db.query(`UPDATE cards SET status = 'INACTIVE', member_id = NULL, deposit_amount = 0, issued_at = NULL, expires_at = NULL, block_reason = NULL WHERE id = $1`, [card.id]);
  await db.query(`UPDATE qr_tokens SET revoked_at = now() WHERE kind = 'CARD_PORTAL' AND target_id = $1 AND revoked_at IS NULL`, [card.id]);
  await audit(db, ctx, { action: 'CARD_RETURN', targetType: 'card', targetId: card.id, targetLabel: card.card_number, oldData: { balance, deposit: card.deposit_amount }, newData: { cashOut }, reason, approverId });
  afterCommit(db, () => emit(['staff', `card:${card.id}`], 'card:update', { cardId: card.id }));
  return { cashOut, transactions: txns };
}

/** Link an existing ACTIVE guest card to a member (converts to member card). */
export async function linkCardToMember(db, ctx, { cardId, memberId }) {
  const card = await lockCard(db, cardId);
  if (card.member_id) throw fail('CONFLICT', 'Card already belongs to a member');
  if (card.status !== 'ACTIVE') throw fail(UNUSABLE[card.status] || 'CARD_BLOCKED');
  const m = await one(db, 'SELECT id FROM members WHERE id = $1 AND status = $2', [memberId, 'ACTIVE']);
  if (!m) throw fail('MEMBER_NOT_FOUND');
  await db.query(`UPDATE cards SET member_id = $2, card_type = 'MEMBER' WHERE id = $1`, [card.id, memberId]);
  await db.query('INSERT INTO card_members(card_id, member_id, linked_by, reason) VALUES ($1,$2,$3,$4)', [card.id, memberId, ctx.staff?.id || null, 'LINK']);
  await audit(db, ctx, { action: 'CARD_LINK', targetType: 'card', targetId: card.id, targetLabel: card.card_number, newData: { memberId } });
  return one(db, 'SELECT * FROM cards WHERE id = $1', [card.id]);
}

export async function cardView(db, card) {
  const member = card.member_id
    ? await one(db, `SELECT m.id, m.member_code, m.first_name, m.last_name, m.nickname, m.phone, m.status, m.tier_id,
                      t.name AS tier_name, t.color AS tier_color, t.code AS tier_code
                       FROM members m LEFT JOIN member_tiers t ON t.id = m.tier_id WHERE m.id = $1`, [card.member_id])
    : null;
  return {
    id: card.id, cardNumber: card.card_number, rfidUid: card.rfid_uid, cardType: card.card_type, status: card.status,
    balance: Number(card.balance), points: card.points, stamps: card.stamps, depositAmount: Number(card.deposit_amount),
    issuedAt: card.issued_at, expiresAt: card.expires_at, lastUsedAt: card.last_used_at, lastTopupAt: card.last_topup_at,
    totalTopup: Number(card.total_topup), totalSpend: Number(card.total_spend), totalPlay: card.total_play,
    replacedBy: card.replaced_by, replacedFrom: card.replaced_from, blockReason: card.block_reason, branchId: card.branch_id,
    createdAt: card.created_at,
    member: member && {
      id: member.id, memberCode: member.member_code, name: `${member.first_name} ${member.last_name}`.trim(), nickname: member.nickname,
      phone: member.phone, status: member.status, tier: member.tier_id ? { id: member.tier_id, name: member.tier_name, color: member.tier_color, code: member.tier_code } : null,
    },
  };
}

export { query };
