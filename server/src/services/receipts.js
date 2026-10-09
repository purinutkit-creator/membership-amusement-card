import { one, many } from '../db/pool.js';
import { dailyNo } from '../lib/ids.js';
import { getSettings } from './settings.js';
import { randomToken } from '../lib/crypto.js';

const maskPhone = (p) => (p ? `${p.slice(0, 3)}***${p.slice(-4)}` : null);
const maskCard = (n) => (n ? `********${n.slice(-4)}` : null);

/** Snapshot everything printed on a receipt so reprints are identical to the original. */
export async function createReceipt(db, ctx, { type, orderId, refundId, transactionId, originalReceiptId, extra = {} }) {
  const order = orderId ? await one(db, 'SELECT * FROM orders WHERE id = $1', [orderId]) : null;
  const branchId = order?.branch_id || ctx.branchId || null;
  const s = await getSettings(branchId);
  const branch = branchId ? await one(db, 'SELECT * FROM branches WHERE id = $1', [branchId]) : null;
  const items = order ? await many(db, 'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [order.id]) : [];
  const payment = order ? await one(db, `SELECT * FROM payments WHERE order_id = $1 AND status IN ('PAID','REFUNDED') ORDER BY created_at DESC LIMIT 1`, [order.id]) : null;
  const member = order?.member_id ? await one(db, 'SELECT member_code, first_name, last_name, phone FROM members WHERE id = $1', [order.member_id]) : null;
  const txns = order ? await many(db, `SELECT t.*, c.card_number FROM transactions t JOIN cards c ON c.id = t.card_id WHERE t.order_id = $1 ORDER BY t.created_at`, [order.id]) : [];
  const staff = ctx.staff ? `${ctx.staff.first_name} ${ctx.staff.last_name || ''}`.trim() : null;
  const prefix = type === 'REFUND' ? 'RFN' : 'RCP';
  const receiptNo = await dailyNo(db, prefix, branch?.code || '');
  const token = randomToken(18);

  const cardTx = txns.filter((t) => ['TOP_UP', 'FOOD_PURCHASE', 'PURCHASE', 'CARD_DEPOSIT', 'REFUND', 'DEPOSIT_REFUND'].includes(t.type));
  const lastByCard = {};
  for (const t of cardTx) lastByCard[t.card_number] = t;
  const data = {
    store: { name: s.general.storeName, company: s.general.companyName, address: branch?.address || s.general.address, phone: branch?.phone || s.general.phone, taxId: branch?.tax_id || s.general.taxId, logoMediaId: s.branding.logoMediaId },
    branch: branch ? { code: branch.code, name: branch.name } : null,
    header: s.receipt.header, footer: s.receipt.footer, thankYou: s.receipt.thankYou,
    receiptNo, type, createdAt: new Date().toISOString(), cashier: staff,
    orderNo: order?.order_no, transactionNos: txns.map((t) => t.txn_no),
    member: member ? { code: member.member_code, name: `${member.first_name} ${member.last_name}`.trim(), phone: maskPhone(member.phone) } : null,
    items: items.map((i) => ({ type: i.item_type, name: i.name, qty: i.qty, unitPrice: Number(i.unit_price), discount: Number(i.discount), total: Number(i.total), bonus: i.meta?.bonus || 0, card: maskCard(i.meta?.cardNumber) })),
    totals: order ? {
      subtotal: Number(order.subtotal), discount: Number(order.manual_discount) + Number(order.promo_discount) + Number(order.tier_discount),
      service: Number(order.service_amount), vat: Number(order.vat_amount), vatMode: order.vat_mode, vatRate: Number(order.vat_rate), grandTotal: Number(order.grand_total),
    } : null,
    payment: payment ? { method: payment.method, amount: Number(payment.amount), received: payment.received_amount != null ? Number(payment.received_amount) : null, change: payment.change_amount != null ? Number(payment.change_amount) : null, ref: payment.provider_ref } : null,
    cards: Object.values(lastByCard).map((t) => ({ number: maskCard(t.card_number), newBalance: Number(t.balance_after), points: t.points_after, stamps: t.stamps_after })),
    pointsEarned: txns.reduce((a, t) => a + Math.max(0, t.points_delta), 0),
    stampsEarned: txns.reduce((a, t) => a + Math.max(0, t.stamps_delta), 0),
    promotions: order?.promotions || [],
    qrToken: token,
    ...extra,
  };
  const receipt = await one(db,
    `INSERT INTO receipts(receipt_no, branch_id, type, order_id, refund_id, transaction_id, original_receipt_id, data, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [receiptNo, branchId, type, orderId || null, refundId || null, transactionId || null, originalReceiptId || null, data, ctx.staff?.id || null]);
  await db.query(`INSERT INTO qr_tokens(token, kind, target_id) VALUES ($1, 'RECEIPT', $2)`, [token, receipt.id]);
  return receipt;
}
