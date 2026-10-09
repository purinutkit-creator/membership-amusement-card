import { one, many } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { dailyNo } from '../lib/ids.js';
import { round2 } from '../lib/money.js';
import { audit } from './audit.js';

export async function openShift(db, ctx, { openingCash, note }) {
  const existing = await one(db, `SELECT id FROM shifts WHERE staff_id = $1 AND status = 'OPEN'`, [ctx.staff.id]);
  if (existing) throw fail('CONFLICT', 'You already have an open shift');
  const s = await one(db, `INSERT INTO shifts(shift_no, branch_id, staff_id, device_id, opening_cash, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [await dailyNo(db, 'SFT'), ctx.branchId || null, ctx.staff.id, ctx.device?.id || null, openingCash, note || null]);
  await audit(db, ctx, { action: 'SHIFT_OPEN', targetType: 'shift', targetId: s.id, targetLabel: s.shift_no, newData: { openingCash } });
  return s;
}

/** Cash expected in drawer = opening + cash sales - cash refunds + cash in - cash out. */
export async function shiftSummary(db, shiftId) {
  const s = await one(db, `SELECT s.*, st.first_name, st.last_name, st.employee_code FROM shifts s JOIN staff st ON st.id = s.staff_id WHERE s.id = $1`, [shiftId]);
  if (!s) throw fail('NOT_FOUND', 'Shift not found');
  const byMethod = await many(db, `SELECT method, count(*)::int AS count, coalesce(sum(amount),0) AS amount FROM payments WHERE shift_id = $1 AND status IN ('PAID','REFUNDED') GROUP BY method ORDER BY method`, [shiftId]);
  const cashSales = Number(byMethod.find((m) => m.method === 'CASH')?.amount || 0);
  const refunds = await many(db, `SELECT method, count(*)::int AS count, coalesce(sum(amount),0) AS amount FROM refunds WHERE shift_id = $1 GROUP BY method`, [shiftId]);
  const cashRefunds = Number(refunds.find((r) => r.method === 'CASH')?.amount || 0);
  const moves = await many(db, `SELECT m.*, st.first_name FROM shift_cash_movements m LEFT JOIN staff st ON st.id = m.staff_id WHERE shift_id = $1 ORDER BY created_at`, [shiftId]);
  const cashIn = moves.filter((m) => m.type === 'CASH_IN').reduce((a, m) => a + Number(m.amount), 0);
  const cashOut = moves.filter((m) => m.type === 'CASH_OUT').reduce((a, m) => a + Number(m.amount), 0);
  const topups = await one(db, `SELECT count(*)::int AS count, coalesce(sum(t.amount),0) AS amount, coalesce(sum(t.bonus),0) AS bonus FROM transactions t JOIN orders o ON o.id = t.order_id WHERE o.shift_id = $1 AND t.type = 'TOP_UP'`, [shiftId]);
  const orders = await one(db, `SELECT count(*) FILTER (WHERE status IN ('PAID','REFUNDED'))::int AS paid, count(*) FILTER (WHERE status = 'CANCELLED')::int AS voided FROM orders WHERE shift_id = $1`, [shiftId]);
  const expected = round2(Number(s.opening_cash) + cashSales - cashRefunds + cashIn - cashOut);
  return {
    shift: s, byMethod, refunds, movements: moves, topups, orders,
    cash: { opening: Number(s.opening_cash), sales: cashSales, refunds: cashRefunds, cashIn: round2(cashIn), cashOut: round2(cashOut), expected },
  };
}

export async function cashMovement(db, ctx, { type, amount, reason }) {
  const s = await one(db, `SELECT * FROM shifts WHERE staff_id = $1 AND status = 'OPEN'`, [ctx.staff.id]);
  if (!s) throw fail('SHIFT_REQUIRED');
  const m = await one(db, 'INSERT INTO shift_cash_movements(shift_id, type, amount, reason, staff_id) VALUES ($1,$2,$3,$4,$5) RETURNING *', [s.id, type, amount, reason, ctx.staff.id]);
  await audit(db, ctx, { action: type, targetType: 'shift', targetId: s.id, targetLabel: s.shift_no, newData: { amount }, reason });
  return m;
}

export async function closeShift(db, ctx, shiftId, { actualCash, note }) {
  const s = await one(db, 'SELECT * FROM shifts WHERE id = $1 FOR UPDATE', [shiftId]);
  if (!s) throw fail('NOT_FOUND');
  if (s.status !== 'OPEN') throw fail('CONFLICT', 'Shift is already closed');
  if (s.staff_id !== ctx.staff.id && !ctx.staff.permissions.has('approval.approve')) throw fail('FORBIDDEN', 'Only the shift owner or a manager can close it');
  const pending = await one(db, `SELECT count(*)::int AS n FROM payments WHERE shift_id = $1 AND status = 'PENDING'`, [shiftId]);
  if (pending.n) throw fail('CONFLICT', `${pending.n} payment(s) still pending — confirm or cancel them first`);
  const sum = await shiftSummary(db, shiftId);
  const overShort = round2(actualCash - sum.cash.expected);
  const upd = await one(db, `UPDATE shifts SET status = 'CLOSED', closed_at = now(), closed_by = $2, expected_cash = $3, actual_cash = $4, over_short = $5, note = coalesce($6, note) WHERE id = $1 RETURNING *`,
    [shiftId, ctx.staff.id, sum.cash.expected, actualCash, overShort, note || null]);
  await audit(db, ctx, { action: 'SHIFT_CLOSE', targetType: 'shift', targetId: s.id, targetLabel: s.shift_no, newData: { expected: sum.cash.expected, actual: actualCash, overShort } });
  return { ...sum, shift: { ...sum.shift, ...upd } };
}
