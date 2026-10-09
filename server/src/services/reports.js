// Report generators. Every figure is computed from ledger / orders / payments — never from cached counters.
import { many, one, query } from '../db/pool.js';
import { dateRange } from '../routes/_util.js';

const db = { query };
function range(q) { return dateRange(q); }
const tsFilter = (col, d, params) => {
  params.push(d.start, d.end);
  return `${col} >= ($${params.length - 1}::timestamp AT TIME ZONE '${d.tz}') AND ${col} < ($${params.length}::timestamp AT TIME ZONE '${d.tz}')`;
};
function opt(clauses, params, col, val) { if (val) { params.push(val); clauses.push(`${col} = $${params.length}`); } }

export const REPORTS = {
  sales: { label: 'Sales Report', async run(q) {
    const d = range(q); const p = []; const c = [tsFilter('o.paid_at', d, p), `o.status IN ('PAID','REFUNDED','PARTIALLY_REFUNDED')`];
    opt(c, p, 'o.branch_id', q.branchId); opt(c, p, 'o.staff_id', q.staffId); opt(c, p, 'o.member_id', q.memberId); opt(c, p, 'o.merchant_id', q.merchantId);
    if (q.method) { p.push(q.method); c.push(`pay.method = $${p.length}`); }
    const rows = await many(db, `SELECT o.order_no, o.paid_at, b.name AS branch, s.first_name AS staff, m.member_code AS member, o.subtotal,
        (o.manual_discount + o.promo_discount + o.tier_discount) AS discount, o.service_amount AS service, o.vat_amount AS vat, o.grand_total AS total, pay.method, o.status, o.refunded_amount AS refunded
      FROM orders o LEFT JOIN branches b ON b.id = o.branch_id LEFT JOIN staff s ON s.id = o.staff_id LEFT JOIN members m ON m.id = o.member_id
      LEFT JOIN LATERAL (SELECT method FROM payments WHERE order_id = o.id AND status IN ('PAID','REFUNDED') LIMIT 1) pay ON true
      WHERE ${c.join(' AND ')} ORDER BY o.paid_at DESC`, p);
    return { columns: [['order_no', 'Order'], ['paid_at', 'Date', 'datetime'], ['branch', 'Branch'], ['staff', 'Staff'], ['member', 'Member'], ['subtotal', 'Subtotal', 'money'], ['discount', 'Discount', 'money'], ['service', 'Service', 'money'], ['vat', 'VAT', 'money'], ['total', 'Total', 'money'], ['method', 'Payment'], ['status', 'Status'], ['refunded', 'Refunded', 'money']], rows,
      summary: { orders: rows.length, gross: sum(rows, 'total'), refunded: sum(rows, 'refunded'), net: round(sum(rows, 'total') - sum(rows, 'refunded')), vat: sum(rows, 'vat'), discount: sum(rows, 'discount') } };
  } },
  topup: { label: 'Top-up Report', async run(q) {
    const d = range(q); const p = []; const c = [tsFilter('t.created_at', d, p), `t.type = 'TOP_UP'`];
    opt(c, p, 't.branch_id', q.branchId); opt(c, p, 't.staff_id', q.staffId); opt(c, p, 't.member_id', q.memberId);
    if (q.method) { p.push(q.method); c.push(`pay.method = $${p.length}`); }
    const rows = await many(db, `SELECT t.txn_no, t.created_at, c.card_number, m.member_code, t.amount, t.bonus, (t.amount + t.bonus) AS credited, t.balance_after, pay.method, s.first_name AS staff, b.name AS branch,
        CASE WHEN t.reversed_by IS NOT NULL THEN 'REFUNDED' ELSE 'COMPLETED' END AS status, tp.channel
      FROM transactions t JOIN cards c ON c.id = t.card_id LEFT JOIN members m ON m.id = t.member_id LEFT JOIN payments pay ON pay.id = t.payment_id
      LEFT JOIN staff s ON s.id = t.staff_id LEFT JOIN branches b ON b.id = t.branch_id LEFT JOIN topups tp ON tp.id = t.topup_id WHERE ${c.join(' AND ')} ORDER BY t.created_at DESC`, p);
    const ok = rows.filter((r) => r.status === 'COMPLETED');
    return { columns: [['txn_no', 'Transaction'], ['created_at', 'Date', 'datetime'], ['card_number', 'Card'], ['member_code', 'Member'], ['amount', 'Paid', 'money'], ['bonus', 'Bonus', 'money'], ['credited', 'Credited', 'money'], ['balance_after', 'New Balance', 'money'], ['method', 'Payment'], ['channel', 'Channel'], ['staff', 'Staff'], ['branch', 'Branch'], ['status', 'Status']], rows,
      summary: { count: ok.length, paid: sum(ok, 'amount'), bonus: sum(ok, 'bonus'), credited: sum(ok, 'credited'), refunded: rows.length - ok.length } };
  } },
  'card-balance': { label: 'Card Balance Report', async run(q) {
    const p = []; const c = ['1=1'];
    opt(c, p, 'c.status', q.status); opt(c, p, 'c.card_type', q.cardType); opt(c, p, 'c.branch_id', q.branchId);
    if (q.nonZero !== '0') c.push('(c.balance > 0 OR c.points > 0 OR c.stamps > 0)');
    const rows = await many(db, `SELECT c.card_number, c.card_type, c.status, m.member_code, m.first_name || ' ' || m.last_name AS member, c.balance, c.points, c.stamps, c.last_used_at, c.expires_at
      FROM cards c LEFT JOIN members m ON m.id = c.member_id WHERE ${c.join(' AND ')} ORDER BY c.balance DESC LIMIT 20000`, p);
    return { columns: [['card_number', 'Card'], ['card_type', 'Type'], ['status', 'Status'], ['member_code', 'Member ID'], ['member', 'Member'], ['balance', 'Balance', 'money'], ['points', 'Points', 'int'], ['stamps', 'Stamps', 'int'], ['last_used_at', 'Last Used', 'datetime'], ['expires_at', 'Expires', 'datetime']], rows,
      summary: { cards: rows.length, balance: sum(rows, 'balance'), points: sum(rows, 'points'), stamps: sum(rows, 'stamps') } };
  } },
  'wallet-liability': { label: 'Wallet Liability', async run() {
    const rows = await many(db, `SELECT c.card_type, c.status, count(*)::int AS cards, sum(c.balance) AS balance, sum(c.points)::int AS points, sum(c.stamps)::int AS stamps, sum(c.deposit_amount) AS deposits
      FROM cards c WHERE c.status <> 'INACTIVE' OR c.balance > 0 GROUP BY 1,2 ORDER BY 1,2`);
    const ledger = await one(db, `SELECT coalesce(sum(amount + bonus),0) AS ledger_total FROM transactions`);
    const total = sum(rows, 'balance');
    return { columns: [['card_type', 'Card Type'], ['status', 'Status'], ['cards', 'Cards', 'int'], ['balance', 'Outstanding Balance', 'money'], ['points', 'Points', 'int'], ['stamps', 'Stamps', 'int'], ['deposits', 'Deposits Held', 'money']], rows,
      summary: { totalLiability: total, activeLiability: sum(rows.filter((r) => r.status === 'ACTIVE'), 'balance'), memberCards: sum(rows.filter((r) => r.card_type === 'MEMBER'), 'balance'), guestCards: sum(rows.filter((r) => r.card_type === 'GUEST'), 'balance'), expired: sum(rows.filter((r) => r.status === 'EXPIRED'), 'balance'), blocked: sum(rows.filter((r) => ['BLOCKED', 'LOST'].includes(r.status)), 'balance'), deposits: sum(rows, 'deposits'), ledgerTotal: Number(ledger.ledger_total), reconciled: round(total) === round(Number(ledger.ledger_total)) } };
  } },
  member: { label: 'Member Report', async run(q) {
    const d = range(q); const p = []; const c = [`m.status NOT IN ('MERGED','DELETED')`];
    if (q.joined === '1') c.push(tsFilter('m.created_at', d, p));
    opt(c, p, 'm.tier_id', q.tierId); opt(c, p, 'm.status', q.status);
    const rows = await many(db, `SELECT m.member_code, m.first_name || ' ' || m.last_name AS name, m.phone, t.name AS tier, m.status, m.join_date, m.total_topup, m.total_spend, m.total_play, m.visit_count, m.lifetime_points, m.last_visit_date,
        (SELECT coalesce(sum(balance),0) FROM cards c WHERE c.member_id = m.id AND c.status = 'ACTIVE') AS balance
      FROM members m LEFT JOIN member_tiers t ON t.id = m.tier_id WHERE ${c.join(' AND ')} ORDER BY m.created_at DESC LIMIT 20000`, p);
    return { columns: [['member_code', 'Member ID'], ['name', 'Name'], ['phone', 'Phone'], ['tier', 'Tier'], ['status', 'Status'], ['join_date', 'Joined'], ['total_topup', 'Total Top-up', 'money'], ['total_spend', 'Total Spend', 'money'], ['total_play', 'Plays', 'int'], ['visit_count', 'Visits', 'int'], ['lifetime_points', 'Lifetime Points', 'int'], ['balance', 'Balance', 'money'], ['last_visit_date', 'Last Visit']], rows,
      summary: { members: rows.length, totalTopup: sum(rows, 'total_topup'), totalSpend: sum(rows, 'total_spend'), balance: sum(rows, 'balance') } };
  } },
  tier: { label: 'Tier Report', async run() {
    const rows = await many(db, `SELECT t.name AS tier, t.rank, count(m.id)::int AS members, coalesce(sum(m.total_spend),0) AS spend, coalesce(sum(m.total_topup),0) AS topup, coalesce(avg(m.total_spend),0)::numeric(14,2) AS avg_spend
      FROM member_tiers t LEFT JOIN members m ON m.tier_id = t.id AND m.status = 'ACTIVE' GROUP BY t.id ORDER BY t.rank`);
    return { columns: [['tier', 'Tier'], ['members', 'Members', 'int'], ['topup', 'Total Top-up', 'money'], ['spend', 'Total Spend', 'money'], ['avg_spend', 'Avg Spend / Member', 'money']], rows, summary: { members: sum(rows, 'members') } };
  } },
  point: { label: 'Point Report', async run(q) { return ledgerReport(q, 't.points_delta <> 0', [['points_delta', 'Points', 'int'], ['points_after', 'Points After', 'int']], (rows) => ({ issued: sum(rows.filter((r) => r.points_delta > 0), 'points_delta'), used: -sum(rows.filter((r) => r.points_delta < 0), 'points_delta') })); } },
  stamp: { label: 'Stamp Report', async run(q) { return ledgerReport(q, 't.stamps_delta <> 0', [['stamps_delta', 'Stamps', 'int'], ['stamps_after', 'Stamps After', 'int']], (rows) => ({ issued: sum(rows.filter((r) => r.stamps_delta > 0), 'stamps_delta'), used: -sum(rows.filter((r) => r.stamps_delta < 0), 'stamps_delta') })); } },
  adjustment: { label: 'Adjustment Report', async run(q) { return ledgerReport(q, `t.type IN ('BALANCE_ADJUSTMENT','POINT_ADD','POINT_REMOVE','STAMP_ADD','STAMP_REMOVE') AND t.staff_id IS NOT NULL AND t.order_id IS NULL`, [['amount', 'Balance Δ', 'money'], ['points_delta', 'Points Δ', 'int'], ['stamps_delta', 'Stamps Δ', 'int'], ['reason', 'Reason'], ['approver', 'Approver']], (rows) => ({ count: rows.length, balance: sum(rows, 'amount') })); } },
  redemption: { label: 'Redemption Report', async run(q) {
    const d = range(q); const p = []; const c = [tsFilter('r.created_at', d, p)];
    opt(c, p, 'r.status', q.status); opt(c, p, 'r.branch_id', q.branchId);
    const rows = await many(db, `SELECT r.code, r.created_at, r.confirmed_at, rw.name AS reward, c.card_number, m.member_code, r.points, r.stamps, r.status, r.channel, s.first_name AS confirmed_by
      FROM redemptions r JOIN rewards rw ON rw.id = r.reward_id JOIN cards c ON c.id = r.card_id LEFT JOIN members m ON m.id = r.member_id LEFT JOIN staff s ON s.id = r.confirmed_by WHERE ${c.join(' AND ')} ORDER BY r.created_at DESC`, p);
    const conf = rows.filter((r) => r.status === 'CONFIRMED');
    return { columns: [['code', 'Code'], ['created_at', 'Requested', 'datetime'], ['confirmed_at', 'Confirmed', 'datetime'], ['reward', 'Reward'], ['card_number', 'Card'], ['member_code', 'Member'], ['points', 'Points', 'int'], ['stamps', 'Stamps', 'int'], ['status', 'Status'], ['channel', 'Channel'], ['confirmed_by', 'Staff']], rows,
      summary: { confirmed: conf.length, points: sum(conf, 'points'), stamps: sum(conf, 'stamps') } };
  } },
  arcade: { label: 'Arcade Report', async run(q) {
    const d = range(q); const p = []; const c = [tsFilter('t.created_at', d, p), `t.type = 'PLAY'`, 't.reversed_by IS NULL'];
    opt(c, p, 't.branch_id', q.branchId); opt(c, p, 't.machine_id', q.machineId);
    const rows = await many(db, `SELECT mc.machine_code, mc.name AS machine, cat.name AS category, mc.zone, count(*)::int AS plays, -sum(t.amount) AS revenue, count(DISTINCT t.card_id)::int AS unique_cards,
        sum(t.points_delta)::int AS points, sum(t.stamps_delta)::int AS stamps, (-sum(t.amount) / count(*))::numeric(14,2) AS avg_price
      FROM transactions t JOIN machines mc ON mc.id = t.machine_id LEFT JOIN machine_categories cat ON cat.id = mc.category_id WHERE ${c.join(' AND ')} GROUP BY mc.id, cat.name ORDER BY revenue DESC`, p);
    return { columns: [['machine_code', 'Code'], ['machine', 'Machine'], ['category', 'Category'], ['zone', 'Zone'], ['plays', 'Plays', 'int'], ['revenue', 'Revenue', 'money'], ['avg_price', 'Avg / Play', 'money'], ['unique_cards', 'Unique Cards', 'int'], ['points', 'Points', 'int'], ['stamps', 'Stamps', 'int']], rows,
      summary: { plays: sum(rows, 'plays'), revenue: sum(rows, 'revenue') } };
  } },
  machine: { label: 'Machine Report', async run(q) {
    const d = range(q); const p = []; tsFilter('t.created_at', d, p);
    const rows = await many(db, `SELECT m.machine_code, m.name, m.status, m.online, m.last_seen_at, m.price, d.device_code,
        count(t.id) FILTER (WHERE t.type = 'PLAY' AND t.reversed_by IS NULL)::int AS plays, coalesce(-sum(t.amount) FILTER (WHERE t.type = 'PLAY' AND t.reversed_by IS NULL),0) AS revenue,
        count(t.id) FILTER (WHERE t.type = 'PLAY' AND t.reversed_by IS NOT NULL)::int AS refunded_plays
      FROM machines m LEFT JOIN devices d ON d.id = m.device_id
      LEFT JOIN transactions t ON t.machine_id = m.id AND t.created_at >= ($1::timestamp AT TIME ZONE '${d.tz}') AND t.created_at < ($2::timestamp AT TIME ZONE '${d.tz}')
      ${q.branchId ? 'WHERE m.branch_id = $3' : ''} GROUP BY m.id, d.device_code ORDER BY revenue DESC`, q.branchId ? [...p, q.branchId] : p);
    return { columns: [['machine_code', 'Code'], ['name', 'Machine'], ['status', 'Status'], ['online', 'Online'], ['last_seen_at', 'Last Seen', 'datetime'], ['device_code', 'Device'], ['price', 'Price', 'money'], ['plays', 'Plays', 'int'], ['revenue', 'Revenue', 'money'], ['refunded_plays', 'Refunded', 'int']], rows,
      summary: { machines: rows.length, online: rows.filter((r) => r.online).length, revenue: sum(rows, 'revenue') } };
  } },
  payment: { label: 'Payment Report', async run(q) {
    const d = range(q); const p = []; const c = [tsFilter('p.created_at', d, p)];
    opt(c, p, 'p.branch_id', q.branchId); opt(c, p, 'p.method', q.method); opt(c, p, 'p.status', q.status);
    const rows = await many(db, `SELECT p.payment_no, p.created_at, p.paid_at, o.order_no, p.method, p.provider, p.amount, p.received_amount, p.change_amount, p.status, p.provider_ref, s.first_name AS confirmed_by
      FROM payments p JOIN orders o ON o.id = p.order_id LEFT JOIN staff s ON s.id = p.confirmed_by WHERE ${c.join(' AND ')} ORDER BY p.created_at DESC`, p);
    const paid = rows.filter((r) => ['PAID', 'REFUNDED'].includes(r.status));
    const byMethod = {};
    for (const r of paid) byMethod[r.method] = round((byMethod[r.method] || 0) + Number(r.amount));
    return { columns: [['payment_no', 'Payment'], ['created_at', 'Created', 'datetime'], ['paid_at', 'Paid', 'datetime'], ['order_no', 'Order'], ['method', 'Method'], ['provider', 'Provider'], ['amount', 'Amount', 'money'], ['received_amount', 'Received', 'money'], ['change_amount', 'Change', 'money'], ['status', 'Status'], ['provider_ref', 'Reference'], ['confirmed_by', 'Confirmed By']], rows,
      summary: { paid: sum(paid, 'amount'), count: paid.length, ...Object.fromEntries(Object.entries(byMethod).map(([k, v]) => [`method_${k}`, v])) } };
  } },
  promotion: { label: 'Promotion Report', async run(q) {
    const d = range(q); const p = []; const c = [tsFilter('u.created_at', d, p)];
    const rows = await many(db, `SELECT pr.name AS promotion, pr.applies_to, pr.effect_type, count(u.id)::int AS uses, coalesce(sum(u.benefit),0) AS benefit, count(DISTINCT u.member_id)::int AS members
      FROM promotion_usage u JOIN promotions pr ON pr.id = u.promotion_id WHERE ${c.join(' AND ')} GROUP BY pr.id ORDER BY uses DESC`, p);
    return { columns: [['promotion', 'Promotion'], ['applies_to', 'Applies To'], ['effect_type', 'Effect'], ['uses', 'Uses', 'int'], ['benefit', 'Total Benefit', 'money'], ['members', 'Members', 'int']], rows, summary: { uses: sum(rows, 'uses'), benefit: sum(rows, 'benefit') } };
  } },
  staff: { label: 'Staff Report', async run(q) {
    const d = range(q); const p = []; tsFilter('x', d, p);
    const rows = await many(db, `SELECT s.employee_code, s.first_name || ' ' || s.last_name AS name, r.name AS role,
        (SELECT count(*)::int FROM orders o WHERE o.staff_id = s.id AND o.status IN ('PAID','REFUNDED') AND o.paid_at >= ($1::timestamp AT TIME ZONE '${d.tz}') AND o.paid_at < ($2::timestamp AT TIME ZONE '${d.tz}')) AS orders,
        (SELECT coalesce(sum(grand_total),0) FROM orders o WHERE o.staff_id = s.id AND o.status IN ('PAID','REFUNDED') AND o.paid_at >= ($1::timestamp AT TIME ZONE '${d.tz}') AND o.paid_at < ($2::timestamp AT TIME ZONE '${d.tz}')) AS sales,
        (SELECT coalesce(sum(amount),0) FROM transactions t WHERE t.staff_id = s.id AND t.type = 'TOP_UP' AND t.created_at >= ($1::timestamp AT TIME ZONE '${d.tz}') AND t.created_at < ($2::timestamp AT TIME ZONE '${d.tz}')) AS topups,
        (SELECT coalesce(sum(amount),0) FROM refunds f WHERE f.staff_id = s.id AND f.created_at >= ($1::timestamp AT TIME ZONE '${d.tz}') AND f.created_at < ($2::timestamp AT TIME ZONE '${d.tz}')) AS refunds,
        (SELECT count(*)::int FROM transactions t WHERE t.staff_id = s.id AND t.type IN ('BALANCE_ADJUSTMENT','POINT_ADD','POINT_REMOVE','STAMP_ADD','STAMP_REMOVE') AND t.order_id IS NULL AND t.created_at >= ($1::timestamp AT TIME ZONE '${d.tz}') AND t.created_at < ($2::timestamp AT TIME ZONE '${d.tz}')) AS adjustments,
        (SELECT coalesce(sum(over_short),0) FROM shifts sh WHERE sh.staff_id = s.id AND sh.closed_at >= ($1::timestamp AT TIME ZONE '${d.tz}') AND sh.closed_at < ($2::timestamp AT TIME ZONE '${d.tz}')) AS over_short
      FROM staff s JOIN roles r ON r.id = s.role_id WHERE s.status <> 'DELETED' ${q.staffId ? 'AND s.id = $3' : ''} ORDER BY sales DESC`, q.staffId ? [...p, q.staffId] : p);
    return { columns: [['employee_code', 'Code'], ['name', 'Name'], ['role', 'Role'], ['orders', 'Orders', 'int'], ['sales', 'Sales', 'money'], ['topups', 'Top-ups', 'money'], ['refunds', 'Refunds', 'money'], ['adjustments', 'Adjustments', 'int'], ['over_short', 'Cash Over/Short', 'money']], rows, summary: { sales: sum(rows, 'sales'), refunds: sum(rows, 'refunds') } };
  } },
  refund: { label: 'Refund Report', async run(q) {
    const d = range(q); const p = []; const c = [tsFilter('f.created_at', d, p)];
    opt(c, p, 'f.branch_id', q.branchId); opt(c, p, 'f.staff_id', q.staffId);
    const rows = await many(db, `SELECT f.refund_no, f.created_at, o.order_no, t.txn_no, f.amount, f.method, f.reason, s.first_name AS staff, a.first_name AS approver
      FROM refunds f LEFT JOIN orders o ON o.id = f.order_id LEFT JOIN transactions t ON t.id = f.transaction_id LEFT JOIN staff s ON s.id = f.staff_id LEFT JOIN staff a ON a.id = f.approver_id WHERE ${c.join(' AND ')} ORDER BY f.created_at DESC`, p);
    return { columns: [['refund_no', 'Refund'], ['created_at', 'Date', 'datetime'], ['order_no', 'Order'], ['txn_no', 'Transaction'], ['amount', 'Amount', 'money'], ['method', 'Method'], ['reason', 'Reason'], ['staff', 'Staff'], ['approver', 'Approver']], rows, summary: { count: rows.length, amount: sum(rows, 'amount') } };
  } },
  merchant: { label: 'Merchant Report (Food Park)', async run(q) {
    const d = range(q); const p = []; tsFilter('x', d, p);
    const rows = await many(db, `SELECT mr.merchant_code, mr.name, mr.commission_pct,
        count(o.id) FILTER (WHERE o.status IN ('PAID','REFUNDED'))::int AS transactions,
        coalesce(sum(o.grand_total) FILTER (WHERE o.status IN ('PAID','REFUNDED')),0) AS gross,
        coalesce(sum(o.refunded_amount),0) AS refunds
      FROM merchants mr LEFT JOIN orders o ON o.merchant_id = mr.id AND o.paid_at >= ($1::timestamp AT TIME ZONE '${d.tz}') AND o.paid_at < ($2::timestamp AT TIME ZONE '${d.tz}')
      GROUP BY mr.id ORDER BY gross DESC`, p);
    for (const r of rows) { r.net = round(Number(r.gross) - Number(r.refunds)); r.commission = round((r.net * Number(r.commission_pct)) / 100); r.settlement = round(r.net - r.commission); }
    return { columns: [['merchant_code', 'Code'], ['name', 'Merchant'], ['transactions', 'Transactions', 'int'], ['gross', 'Gross Sales', 'money'], ['refunds', 'Refunds', 'money'], ['net', 'Net Sales', 'money'], ['commission_pct', 'Commission %'], ['commission', 'Commission', 'money'], ['settlement', 'Settlement', 'money']], rows,
      summary: { gross: sum(rows, 'gross'), net: sum(rows, 'net'), settlement: sum(rows, 'settlement') } };
  } },
  shift: { label: 'Shift Report', async run(q) {
    const d = range(q); const p = []; const c = [tsFilter('sh.opened_at', d, p)];
    opt(c, p, 'sh.staff_id', q.staffId); opt(c, p, 'sh.branch_id', q.branchId);
    const rows = await many(db, `SELECT sh.shift_no, st.first_name || ' ' || st.last_name AS staff, sh.status, sh.opened_at, sh.closed_at, sh.opening_cash, sh.expected_cash, sh.actual_cash, sh.over_short
      FROM shifts sh JOIN staff st ON st.id = sh.staff_id WHERE ${c.join(' AND ')} ORDER BY sh.opened_at DESC`, p);
    return { columns: [['shift_no', 'Shift'], ['staff', 'Staff'], ['status', 'Status'], ['opened_at', 'Opened', 'datetime'], ['closed_at', 'Closed', 'datetime'], ['opening_cash', 'Opening', 'money'], ['expected_cash', 'Expected', 'money'], ['actual_cash', 'Actual', 'money'], ['over_short', 'Over/Short', 'money']], rows, summary: { shifts: rows.length, overShort: sum(rows, 'over_short') } };
  } },
  transactions: { label: 'Transaction Ledger', async run(q) { return ledgerReport(q, '1=1', [['amount', 'Amount', 'money'], ['bonus', 'Bonus', 'money'], ['balance_after', 'Balance After', 'money'], ['points_delta', 'Points', 'int'], ['stamps_delta', 'Stamps', 'int'], ['reason', 'Reason']], (rows) => ({ count: rows.length })); } },
};

async function ledgerReport(q, cond, extraCols, summarize) {
  const d = range(q); const p = []; const c = [tsFilter('t.created_at', d, p), cond];
  opt(c, p, 't.branch_id', q.branchId); opt(c, p, 't.staff_id', q.staffId); opt(c, p, 't.member_id', q.memberId); opt(c, p, 't.machine_id', q.machineId); opt(c, p, 't.type', q.type);
  if (q.tierId) { p.push(q.tierId); c.push(`m.tier_id = $${p.length}`); }
  const rows = await many(db, `SELECT t.txn_no, t.created_at, t.type, c.card_number, m.member_code, t.amount, t.bonus, t.balance_after, t.points_delta, t.points_after, t.stamps_delta, t.stamps_after,
      t.reason, s.first_name AS staff, a.first_name AS approver, mc.name AS machine, d.device_code AS device, b.name AS branch
    FROM transactions t JOIN cards c ON c.id = t.card_id LEFT JOIN members m ON m.id = t.member_id LEFT JOIN staff s ON s.id = t.staff_id LEFT JOIN staff a ON a.id = t.approver_id
    LEFT JOIN machines mc ON mc.id = t.machine_id LEFT JOIN devices d ON d.id = t.device_id LEFT JOIN branches b ON b.id = t.branch_id WHERE ${c.join(' AND ')} ORDER BY t.created_at DESC LIMIT 50000`, p);
  return { columns: [['txn_no', 'Transaction'], ['created_at', 'Date', 'datetime'], ['type', 'Type'], ['card_number', 'Card'], ['member_code', 'Member'], ...extraCols, ['staff', 'Staff'], ['machine', 'Machine'], ['device', 'Device'], ['branch', 'Branch']], rows, summary: summarize(rows) };
}

function round(n) { return Math.round(Number(n) * 100) / 100; }
function sum(rows, k) { return round(rows.reduce((a, r) => a + Number(r[k] || 0), 0)); }

/** Dashboard KPIs + charts from real ledger data. */
export async function dashboard(q) {
  const d = dateRange(q.range ? q : { range: 'today' });
  const tz = d.tz;
  const p = [d.start, d.end];
  const W = (col) => `${col} >= ($1::timestamp AT TIME ZONE '${tz}') AND ${col} < ($2::timestamp AT TIME ZONE '${tz}')`;
  const branch = q.branchId ? ` AND branch_id = '${String(q.branchId).replace(/[^0-9a-f-]/gi, '')}'` : '';
  const [pay, refunds, tx, members, cards, redemptions, active] = await Promise.all([
    one(db, `SELECT coalesce(sum(amount) FILTER (WHERE method <> 'CARD_BALANCE'),0) AS cash_in, count(*)::int AS payments FROM payments WHERE status IN ('PAID','REFUNDED') AND ${W('paid_at')}${branch}`, p),
    one(db, `SELECT coalesce(sum(amount) FILTER (WHERE method <> 'CARD_BALANCE'),0) AS refunds FROM refunds WHERE ${W('created_at')}${branch}`, p),
    one(db, `SELECT coalesce(sum(amount) FILTER (WHERE type = 'TOP_UP'),0) AS topup, coalesce(sum(bonus) FILTER (WHERE type = 'TOP_UP'),0) AS topup_bonus,
        coalesce(-sum(amount) FILTER (WHERE type = 'PLAY' AND reversed_by IS NULL),0) AS arcade, count(*) FILTER (WHERE type = 'PLAY' AND reversed_by IS NULL)::int AS plays,
        coalesce(-sum(amount) FILTER (WHERE type IN ('FOOD_PURCHASE','PURCHASE') AND reversed_by IS NULL),0) AS card_food,
        coalesce(sum(stamps_delta) FILTER (WHERE stamps_delta > 0),0)::int AS stamps, coalesce(sum(points_delta) FILTER (WHERE points_delta > 0),0)::int AS points,
        count(DISTINCT card_id) FILTER (WHERE type IN ('PLAY','FOOD_PURCHASE','TOP_UP'))::int AS active_cards, count(DISTINCT member_id)::int AS active_members
      FROM transactions WHERE ${W('created_at')}${branch}`, p),
    one(db, `SELECT count(*)::int AS new_members FROM members WHERE ${W('created_at')}`, p),
    one(db, `SELECT count(*) FILTER (WHERE status = 'ACTIVE')::int AS active_cards_total, coalesce(sum(balance),0) AS liability FROM cards`),
    one(db, `SELECT count(*)::int AS n FROM redemptions WHERE status = 'CONFIRMED' AND ${W('confirmed_at')}`, p),
    one(db, `SELECT count(*)::int AS n FROM members WHERE status = 'ACTIVE' AND last_visit_date >= (now() AT TIME ZONE '${tz}')::date - 30`),
  ]);
  const foodPos = await one(db, `SELECT coalesce(sum(oi.total),0) AS food FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN payments pm ON pm.order_id = o.id AND pm.status = 'PAID' AND pm.method <> 'CARD_BALANCE'
      WHERE oi.item_type = 'PRODUCT' AND o.status = 'PAID' AND ${W('o.paid_at')}`, p);
  const revenue = round(Number(pay.cash_in) - Number(refunds.refunds));
  const byHour = await many(db, `SELECT extract(hour FROM paid_at AT TIME ZONE '${tz}')::int AS hour, sum(amount) AS amount FROM payments WHERE status = 'PAID' AND method <> 'CARD_BALANCE' AND ${W('paid_at')}${branch} GROUP BY 1 ORDER BY 1`, p);
  const byDay = await many(db, `SELECT to_char(d, 'YYYY-MM-DD') AS day,
      (SELECT coalesce(sum(amount),0) FROM payments WHERE status = 'PAID' AND method <> 'CARD_BALANCE' AND (paid_at AT TIME ZONE '${tz}')::date = d::date) AS revenue,
      (SELECT coalesce(sum(amount),0) FROM transactions WHERE type = 'TOP_UP' AND (created_at AT TIME ZONE '${tz}')::date = d::date) AS topup,
      (SELECT count(*)::int FROM transactions WHERE type = 'PLAY' AND reversed_by IS NULL AND (created_at AT TIME ZONE '${tz}')::date = d::date) AS plays
    FROM generate_series((now() AT TIME ZONE '${tz}')::date - 13, (now() AT TIME ZONE '${tz}')::date, '1 day') d`);
  const topMachines = await many(db, `SELECT m.name, count(*)::int AS plays, -sum(t.amount) AS revenue FROM transactions t JOIN machines m ON m.id = t.machine_id WHERE t.type = 'PLAY' AND t.reversed_by IS NULL AND ${W('t.created_at')} GROUP BY m.id ORDER BY revenue DESC LIMIT 8`, p);
  const topPackages = await many(db, `SELECT pk.name, count(*)::int AS count, sum(tp.pay_amount) AS amount FROM topups tp JOIN topup_packages pk ON pk.id = tp.package_id WHERE tp.status = 'COMPLETED' AND ${W('tp.completed_at')} GROUP BY pk.id ORDER BY count DESC LIMIT 8`, p);
  const topPromotions = await many(db, `SELECT pr.name, count(*)::int AS uses, sum(u.benefit) AS benefit FROM promotion_usage u JOIN promotions pr ON pr.id = u.promotion_id WHERE ${W('u.created_at')} GROUP BY pr.id ORDER BY uses DESC LIMIT 8`, p);
  const tiers = await many(db, `SELECT t.name, t.color, count(m.id)::int AS members FROM member_tiers t LEFT JOIN members m ON m.tier_id = t.id AND m.status = 'ACTIVE' GROUP BY t.id ORDER BY t.rank`);
  const methods = await many(db, `SELECT method, count(*)::int AS count, sum(amount) AS amount FROM payments WHERE status = 'PAID' AND ${W('paid_at')}${branch} GROUP BY method ORDER BY amount DESC`, p);
  const machines = await one(db, `SELECT count(*)::int AS total, count(*) FILTER (WHERE online)::int AS online, count(*) FILTER (WHERE status = 'MAINTENANCE')::int AS maintenance, count(*) FILTER (WHERE status IN ('ERROR','DISABLED'))::int AS down FROM machines`);
  const visits = Math.max(1, tx.active_members || 0);
  return {
    range: { from: d.from, to: d.to },
    kpi: {
      revenue, cashIn: Number(pay.cash_in), refunds: Number(refunds.refunds), topup: Number(tx.topup), topupBonus: Number(tx.topup_bonus), arcadeRevenue: Number(tx.arcade),
      foodRevenue: round(Number(tx.card_food) + Number(foodPos.food)), plays: tx.plays, stampsIssued: tx.stamps, pointsIssued: tx.points,
      activeCards: tx.active_cards, activeCardsTotal: cards.active_cards_total, newMembers: members.new_members, activeMembers: tx.active_members, activeMembers30d: active.n,
      rewardsRedeemed: redemptions.n, averageSpend: round((Number(tx.arcade) + Number(tx.card_food)) / visits), walletLiability: Number(cards.liability),
    },
    charts: { byHour, byDay, topMachines, topPackages, topPromotions, tiers, methods },
    machines,
  };
}

export async function ownerDashboard(q) {
  const d = dateRange(q.range ? q : { range: 'today' });
  const p = [d.start, d.end];
  const W = (col) => `${col} >= ($1::timestamp AT TIME ZONE '${d.tz}') AND ${col} < ($2::timestamp AT TIME ZONE '${d.tz}')`;
  const branches = await many(db, `SELECT b.id, b.code, b.name,
      (SELECT coalesce(sum(amount),0) FROM payments x WHERE x.branch_id = b.id AND x.status IN ('PAID','REFUNDED') AND x.method <> 'CARD_BALANCE' AND ${W('x.paid_at')}) AS revenue,
      (SELECT coalesce(sum(amount),0) FROM transactions t WHERE t.branch_id = b.id AND t.type = 'TOP_UP' AND ${W('t.created_at')}) AS topup,
      (SELECT coalesce(-sum(amount),0) FROM transactions t WHERE t.branch_id = b.id AND t.type IN ('PLAY','FOOD_PURCHASE','PURCHASE') AND t.reversed_by IS NULL AND ${W('t.created_at')}) AS spend,
      (SELECT count(*)::int FROM transactions t WHERE t.branch_id = b.id AND t.type = 'PLAY' AND t.reversed_by IS NULL AND ${W('t.created_at')}) AS plays,
      (SELECT count(*)::int FROM shifts s WHERE s.branch_id = b.id AND s.status = 'OPEN') AS open_shifts,
      (SELECT count(*)::int FROM machines m WHERE m.branch_id = b.id AND m.online) AS machines_online,
      (SELECT count(*)::int FROM machines m WHERE m.branch_id = b.id) AS machines
    FROM branches b ORDER BY b.code`, p);
  const liability = await REPORTS['wallet-liability'].run({});
  const reward = await one(db, `SELECT coalesce(sum(points),0)::int AS points, coalesce(sum(stamps),0)::int AS stamps FROM cards WHERE status = 'ACTIVE'`);
  const pendingRedemptions = await one(db, `SELECT count(*)::int AS n, coalesce(sum(points),0)::int AS points FROM redemptions WHERE status = 'PENDING' AND (expires_at IS NULL OR expires_at > now())`);
  const shifts = await many(db, `SELECT s.shift_no, s.opened_at, s.opening_cash, st.first_name || ' ' || st.last_name AS staff, b.name AS branch FROM shifts s JOIN staff st ON st.id = s.staff_id LEFT JOIN branches b ON b.id = s.branch_id WHERE s.status = 'OPEN' ORDER BY s.opened_at`);
  const totals = await one(db, `SELECT (SELECT count(*)::int FROM members WHERE status = 'ACTIVE') AS members, (SELECT count(*)::int FROM cards WHERE status = 'ACTIVE') AS active_cards`);
  const machinePerf = await many(db, `SELECT m.name, m.machine_code, count(t.id)::int AS plays, coalesce(-sum(t.amount),0) AS revenue FROM machines m LEFT JOIN transactions t ON t.machine_id = m.id AND t.type = 'PLAY' AND t.reversed_by IS NULL AND ${W('t.created_at')} GROUP BY m.id ORDER BY revenue DESC LIMIT 10`, p);
  const unbranched = await one(db, `SELECT coalesce(sum(amount),0) AS revenue FROM payments WHERE branch_id IS NULL AND status IN ('PAID','REFUNDED') AND method <> 'CARD_BALANCE' AND ${W('paid_at')}`, p);
  return { range: { from: d.from, to: d.to }, branches, unbranchedRevenue: Number(unbranched.revenue), liability: liability.summary, liabilityRows: liability.rows, rewardLiability: { ...reward, pendingRedemptions }, openShifts: shifts, totals, machinePerformance: machinePerf };
}
