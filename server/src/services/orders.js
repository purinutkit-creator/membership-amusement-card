// =====================================================================
// ORDERS & PAYMENTS
// Order lifecycle: PENDING_PAYMENT -> (payment confirmed) PAID -> [REFUNDED]
// Fulfilment (top-ups, card issue, stock-out, points) runs in the SAME db transaction
// that marks the payment PAID, so balance is never added before payment is confirmed
// and a duplicated confirmation/webhook can never top-up twice.
// =====================================================================
import { tx, one, many, query, afterCommit } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { dailyNo } from '../lib/ids.js';
import { round2, pct, sum, sub } from '../lib/money.js';
import { getSettings } from './settings.js';
import { lockCard, postEntry, reverseTransaction } from './ledger.js';
import { assertUsable, issueCard, replaceCard, getCardById, findCard } from './cards.js';
import { evaluatePromotions, applyPriceEffects, rewardEffects, recordUsage } from './promotions.js';
import { computeEarn } from './earning.js';
import { bumpMemberStats, evaluateTier, getMemberTier } from './tiers.js';
import { autoConvert } from './loyalty.js';
import { createReceipt } from './receipts.js';
import { audit } from './audit.js';
import { notify } from './notifications.js';
import { emit } from '../realtime.js';
import { promptPayFromSettings } from '../lib/promptpay.js';
import { getGateway } from '../integrations/payment/index.js';
import { verifyStaffCredentials, loadStaff } from './auth.js';
import { logger } from '../lib/logger.js';

const STAFF_CONFIRMED = ['CREDIT_CARD', 'DEBIT_CARD', 'E_WALLET', 'OTHER'];

export async function openShiftFor(db, staffId) {
  return one(db, `SELECT * FROM shifts WHERE staff_id = $1 AND status = 'OPEN'`, [staffId]);
}

async function packageEligible(db, pkg, { memberId, tierId, branchId, cardId }) {
  const now = new Date();
  if (pkg.status !== 'ACTIVE') return 'Package is inactive';
  if (pkg.start_at && new Date(pkg.start_at) > now) return 'Package has not started';
  if (pkg.end_at && new Date(pkg.end_at) <= now) return 'Package has ended';
  if (pkg.member_only && !memberId) return 'Package is for members only';
  if (pkg.tier_ids?.length && !pkg.tier_ids.includes(tierId)) return 'Package is not available for this tier';
  if (pkg.branch_ids?.length && branchId && !pkg.branch_ids.includes(branchId)) return 'Package is not available at this branch';
  if (pkg.usage_limit != null && pkg.used_count >= pkg.usage_limit) return 'Package usage limit reached';
  if (pkg.per_card_limit != null && cardId) {
    const n = (await one(db, `SELECT count(*)::int AS n FROM topups WHERE package_id = $1 AND card_id = $2 AND status = 'COMPLETED'`, [pkg.id, cardId])).n;
    if (n >= pkg.per_card_limit) return 'Package limit for this card reached';
  }
  return null;
}

/**
 * Price an order (no writes). Validates card ↔ member verification for top-ups.
 * input: { items, memberId, cardId, manualDiscount:{mode,value}, merchantId, channel }
 */
export async function priceOrder(db, ctx, input) {
  const s = await getSettings(ctx.branchId);
  const member = input.memberId ? await one(db, 'SELECT * FROM members WHERE id = $1', [input.memberId]) : null;
  if (input.memberId && !member) throw fail('MEMBER_NOT_FOUND');
  if (member && member.status !== 'ACTIVE') throw fail('MEMBER_SUSPENDED');
  const tier = await getMemberTier(db, member?.id);
  const lines = [];
  const issuing = new Set(input.items.filter((i) => i.type === 'CARD_ISSUE').map((i) => i.cardId));
  const promotions = [];

  for (const it of input.items) {
    if (it.type === 'PRODUCT') {
      const p = await one(db, 'SELECT * FROM products WHERE id = $1', [it.productId]);
      if (!p || p.status !== 'ACTIVE') throw fail('NOT_FOUND', 'Product not available');
      if (p.track_stock && p.stock < it.qty) throw fail('OUT_OF_STOCK', `${p.name}: only ${p.stock} left`);
      const gross = round2(Number(p.price) * it.qty);
      const discount = Math.min(round2(it.discount || 0), gross);
      lines.push({ type: 'PRODUCT', productId: p.id, name: p.name, qty: it.qty, unitPrice: Number(p.price), discount, total: sub(gross, discount), taxable: p.taxable, kind: p.kind, merchantId: p.merchant_id, meta: {} });
    } else if (it.type === 'TOPUP') {
      const card = await getCardById(db, it.cardId);
      if (!issuing.has(card.id)) await assertUsable(db, card);
      // REQUIRED MEMBER + CARD verification: card must belong to the identified member
      if (member && card.member_id !== member.id && !(issuing.has(card.id))) throw fail('CARD_MEMBER_MISMATCH');
      if (!member && card.member_id && input.channel !== 'ONLINE') {
        // card belongs to a member but no member was verified: allowed only if setting doesn't require verification
        if (s.topup.requireCardVerification) throw fail('CARD_MEMBER_MISMATCH', 'This is a member card — identify the member first');
      }
      let pay, bonus = 0, pointBonus = 0, stampBonus = 0, pkg = null;
      if (it.packageId) {
        pkg = await one(db, 'SELECT * FROM topup_packages WHERE id = $1', [it.packageId]);
        if (!pkg) throw fail('NOT_FOUND', 'Package not found');
        const why = await packageEligible(db, pkg, { memberId: member?.id, tierId: tier?.id, branchId: ctx.branchId, cardId: card.id });
        if (why) throw fail('NOT_ELIGIBLE', why);
        pay = Number(pkg.pay_amount); bonus = Number(pkg.bonus_amount); pointBonus = pkg.point_bonus; stampBonus = pkg.stamp_bonus;
      } else {
        if (!s.topup.allowCustomAmount) throw fail('VALIDATION_ERROR', 'Choose a top-up package');
        pay = round2(it.amount);
      }
      if (!(pay > 0)) throw fail('VALIDATION_ERROR', 'Top-up amount must be greater than 0');
      if (pay < s.wallet.minTopup) throw fail('VALIDATION_ERROR', `Minimum top-up is ฿${s.wallet.minTopup}`);
      if (pay > s.wallet.maxTopup) throw fail('VALIDATION_ERROR', `Maximum top-up is ฿${s.wallet.maxTopup}`);
      const packageBonus = bonus;
      const tierBonus = tier?.benefits?.topupBonusPct ? pct(pay, tier.benefits.topupBonusPct) : 0;
      const promo = await evaluatePromotions(db, { appliesTo: 'TOP_UP', amount: pay, memberId: member?.id, cardId: card.id, tierId: tier?.id, birthday: member?.birthday, branchId: ctx.branchId, packageId: pkg?.id });
      const fx = rewardEffects(pay, promo.applied);
      bonus = round2(packageBonus + tierBonus + fx.bonus);
      pointBonus += fx.pointBonus; stampBonus += fx.stampBonus;
      const newBalance = round2(Number(card.balance) + pay + bonus);
      if (newBalance > s.wallet.maxBalance) throw fail('MAX_BALANCE', `Maximum card balance is ฿${s.wallet.maxBalance}`);
      promotions.push(...fx.used);
      lines.push({
        type: 'TOPUP', cardId: card.id, packageId: pkg?.id || null, name: pkg ? `Top Up: ${pkg.name}` : `Top Up ฿${pay.toFixed(2)}`, qty: 1, unitPrice: pay, discount: 0, total: pay, taxable: false,
        meta: { cardNumber: card.card_number, bonus, packageBonus, tierBonus, promoBonus: fx.bonus, pointBonus, stampBonus, promotions: fx.used, currentBalance: Number(card.balance), newBalance },
      });
    } else if (it.type === 'CARD_ISSUE') {
      const card = await getCardById(db, it.cardId);
      if (card.status !== 'INACTIVE') throw fail('CARD_IN_USE', `Card ${card.card_number} is ${card.status}`);
      const deposit = it.waiveDeposit ? 0 : Number(s.card.deposit || 0);
      lines.push({ type: 'CARD_ISSUE', cardId: card.id, name: `${it.memberId || member ? 'Member' : 'Guest'} Card Deposit`, qty: 1, unitPrice: deposit, discount: 0, total: deposit, taxable: false,
        meta: { cardNumber: card.card_number, memberId: it.memberId || member?.id || null, waiveReason: it.waiveDeposit ? it.waiveReason || 'Waived' : null } });
    } else if (it.type === 'CARD_REPLACEMENT') {
      const oldC = await getCardById(db, it.oldCardId);
      const newC = await getCardById(db, it.newCardId);
      if (newC.status !== 'INACTIVE') throw fail('CARD_IN_USE');
      if (member && oldC.member_id !== member.id) throw fail('CARD_MEMBER_MISMATCH');
      const fee = Number(s.card.replacementFee || 0);
      lines.push({ type: 'CARD_REPLACEMENT', cardId: newC.id, name: 'Card Replacement', qty: 1, unitPrice: fee, discount: 0, total: fee, taxable: false,
        meta: { oldCardId: oldC.id, oldCardNumber: oldC.card_number, cardNumber: newC.card_number, reason: it.reason || 'Card replacement', balance: Number(oldC.balance) } });
    }
  }

  // ---- products: manual discount -> tier discount -> FOOD promotions -> service -> VAT
  const productLines = lines.filter((l) => l.type === 'PRODUCT');
  const productGross = sum(productLines.map((l) => round2(l.unitPrice * l.qty)));
  const lineDiscounts = sum(productLines.map((l) => l.discount));
  let productNet = sum(productLines.map((l) => l.total));
  let manualDiscount = 0;
  if (input.manualDiscount?.value > 0) {
    manualDiscount = input.manualDiscount.mode === 'PERCENT' ? pct(productNet, input.manualDiscount.value) : round2(input.manualDiscount.value);
    manualDiscount = Math.min(manualDiscount, productNet);
    productNet = sub(productNet, manualDiscount);
  }
  const tierDiscount = tier?.benefits?.discountPct && productNet > 0 ? pct(productNet, tier.benefits.discountPct) : 0;
  productNet = sub(productNet, tierDiscount);
  let promoDiscount = 0;
  if (productNet > 0) {
    const promo = await evaluatePromotions(db, { appliesTo: 'FOOD', amount: productNet, memberId: member?.id, cardId: input.cardId, tierId: tier?.id, birthday: member?.birthday, branchId: ctx.branchId, merchantId: input.merchantId });
    const priced = applyPriceEffects(productNet, promo.applied.filter((p) => ['DISCOUNT_AMOUNT', 'DISCOUNT_PERCENT', 'FIXED_PRICE'].includes(p.effect_type)));
    promoDiscount = sub(productNet, priced.price);
    productNet = priced.price;
    const fx = rewardEffects(productNet, promo.applied);
    promotions.push(...priced.used, ...fx.used.filter((u) => !u.bonus));
  }
  const staffDiscount = round2(lineDiscounts + manualDiscount);
  const discountPct = productGross > 0 ? (staffDiscount / productGross) * 100 : 0;

  const taxableBase = sum(productLines.filter((l) => l.taxable).map((l) => l.total)) > 0 ? productNet : 0;
  const serviceRate = s.tax.serviceMode === 'OFF' ? 0 : Number(s.tax.serviceRate || 0);
  const service = productNet > 0 && serviceRate ? pct(productNet, serviceRate) : 0;
  const vatRate = s.tax.vatMode === 'OFF' ? 0 : Number(s.tax.vatRate || 0);
  let vat = 0;
  if (vatRate && taxableBase > 0) {
    const base = round2(taxableBase + service);
    vat = s.tax.vatMode === 'EXCLUSIVE' ? pct(base, vatRate) : round2((base * vatRate) / (100 + vatRate));
  }
  const nonProduct = sum(lines.filter((l) => l.type !== 'PRODUCT').map((l) => l.total));
  const subtotal = round2(productGross + nonProduct);
  const grandTotal = round2(productNet + service + (s.tax.vatMode === 'EXCLUSIVE' ? vat : 0) + nonProduct);

  return {
    lines, member: member && { id: member.id, code: member.member_code, name: `${member.first_name} ${member.last_name}`.trim(), tier: tier?.name || null },
    totals: { subtotal, lineDiscounts, manualDiscount, tierDiscount, promoDiscount, discountPct: round2(discountPct), serviceRate, service, vatMode: s.tax.vatMode, vatRate, vat, grandTotal },
    promotions,
  };
}

async function checkDiscountAuthority(ctx, discountPct, approval) {
  if (discountPct <= 0) return null;
  if (!ctx.staff?.permissions.has('pos.discount')) throw fail('FORBIDDEN', 'You cannot give discounts');
  if (discountPct <= ctx.staff.max_discount) return null;
  if (!approval?.employeeCode || !approval?.pin) throw fail('APPROVAL_REQUIRED', `Discount ${discountPct.toFixed(1)}% exceeds your limit of ${ctx.staff.max_discount}%`, { permission: 'pos.discount' });
  let approver;
  try { approver = await loadStaff((await verifyStaffCredentials(approval)).id); } catch { throw fail('INVALID_APPROVAL'); }
  if (!approver.permissions.has('approval.approve') || approver.max_discount < discountPct) throw fail('INVALID_APPROVAL', 'Approver discount limit is too low');
  return approver.id;
}

export async function createOrder(ctx, input) {
  return tx(async (db) => {
    const priced = await priceOrder(db, ctx, input);
    if (!priced.lines.length) throw fail('VALIDATION_ERROR', 'Cart is empty');
    const approverId = await checkDiscountAuthority(ctx, priced.totals.discountPct, input.approval);
    const channel = input.channel || 'POS';
    let shift = null;
    if (channel === 'POS' && ctx.staff) {
      shift = await openShiftFor(db, ctx.staff.id);
      if (!shift) throw fail('SHIFT_REQUIRED');
    }
    const t = priced.totals;
    const order = await one(db,
      `INSERT INTO orders(order_no, branch_id, merchant_id, staff_id, device_id, shift_id, member_id, card_id, channel, subtotal,
          manual_discount, promo_discount, tier_discount, vat_mode, vat_rate, vat_amount, service_rate, service_amount, grand_total,
          promotions, note, discount_approver_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
      [await dailyNo(db, 'ORD'), ctx.branchId || null, input.merchantId || ctx.staff?.merchant_id || null, ctx.staff?.id || null, ctx.device?.id || null,
        shift?.id || null, input.memberId || null, input.cardId || null, channel, t.subtotal, round2(t.lineDiscounts + t.manualDiscount), t.promoDiscount, t.tierDiscount,
        t.vatMode, t.vatRate, t.vat, t.serviceRate, t.service, t.grandTotal, JSON.stringify(priced.promotions), input.note || null, approverId]);
    for (const l of priced.lines) {
      await db.query(
        `INSERT INTO order_items(order_id, item_type, product_id, package_id, card_id, name, qty, unit_price, discount, total, taxable, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [order.id, l.type, l.productId || null, l.packageId || null, l.cardId || null, l.name, l.qty, l.unitPrice, l.discount, l.total, l.taxable, l.meta]);
    }
    if (approverId) await audit(db, ctx, { action: 'DISCOUNT_APPROVED', targetType: 'order', targetId: order.id, targetLabel: order.order_no, newData: { discountPct: t.discountPct }, approverId });
    return { order, priced };
  });
}

/** Start payment for an order. Returns { payment, order, completed } */
export async function payOrder(ctx, orderId, input) {
  const s = await getSettings(ctx.branchId);
  const method = input.method;
  const pm = await one({ query }, 'SELECT * FROM payment_methods WHERE code = $1', [method]);
  if (!pm || !pm.enabled) throw fail('PAYMENT_FAILED', `Payment method ${method} is not enabled`);

  const res = await tx(async (db) => {
    const order = await one(db, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!order) throw fail('NOT_FOUND', 'Order not found');
    if (order.status !== 'PENDING_PAYMENT') throw fail('CONFLICT', `Order is ${order.status}`);
    // cancel stale pending attempts for this order (e.g. switching from PromptPay to cash)
    await db.query(`UPDATE payments SET status = 'CANCELLED', updated_at = now() WHERE order_id = $1 AND status = 'PENDING'`, [order.id]);
    const amount = Number(order.grand_total);
    const shift = ctx.staff ? await openShiftFor(db, ctx.staff.id) : null;
    if (order.channel === 'POS' && !shift) throw fail('SHIFT_REQUIRED');
    const base = { order_id: order.id, method, amount, branch_id: order.branch_id, shift_id: shift?.id || null };
    const ins = async (extra) => one(db,
      `INSERT INTO payments(payment_no, order_id, method, provider, amount, received_amount, change_amount, status, provider_ref, qr_payload, expires_at, branch_id, shift_id, card_id, idempotency_key, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [await dailyNo(db, 'PAY'), base.order_id, method, extra.provider || 'internal', amount, extra.received ?? null, extra.change ?? null, extra.providerRef || null,
        extra.qr || null, extra.expiresAt || null, base.branch_id, base.shift_id, extra.cardId || null, input.idempotencyKey || null, extra.meta || {}]);

    if (method === 'CASH') {
      const received = round2(input.receivedAmount ?? amount);
      if (received < amount) throw fail('PAYMENT_FAILED', `Cash received ฿${received.toFixed(2)} is less than ฿${amount.toFixed(2)}`);
      const p = await ins({ received, change: round2(received - amount) });
      return { payment: p, confirmNow: true, order };
    }
    if (method === 'CARD_BALANCE') {
      const items = await many(db, 'SELECT item_type FROM order_items WHERE order_id = $1', [order.id]);
      if (items.some((i) => i.item_type !== 'PRODUCT')) throw fail('PAYMENT_FAILED', 'Card balance can only pay for products');
      const card = await findCard(db, input.cardIdentifier);
      const p = await ins({ cardId: card.id, meta: { cardNumber: card.card_number } });
      return { payment: p, confirmNow: true, order, payCardId: card.id };
    }
    if (method === 'PROMPTPAY') {
      let qr;
      try { qr = promptPayFromSettings(s.promptpay, amount); } catch (e) { throw fail('PAYMENT_FAILED', e.message); }
      const p = await ins({ qr, expiresAt: new Date(Date.now() + (s.promptpay.expiryMinutes || 10) * 60000), meta: { qrType: s.promptpay.qrType, merchantName: s.promptpay.merchantName } });
      return { payment: p, confirmNow: false, order };
    }
    if (method === 'BANK_TRANSFER') {
      const p = await ins({ meta: { bank: s.bank } });
      return { payment: p, confirmNow: false, order };
    }
    if (STAFF_CONFIRMED.includes(method)) {
      // External EDC / wallet terminal. Staff keys in the approval code. No card data stored.
      if (!input.reference) throw fail('VALIDATION_ERROR', 'Enter the approval / reference code from the terminal');
      const p = await ins({ providerRef: null, meta: { reference: String(input.reference).slice(0, 60) } });
      return { payment: p, confirmNow: true, order };
    }
    if (method === 'GATEWAY') {
      const gw = getGateway();
      if (!gw) throw fail('PAYMENT_FAILED', 'No payment gateway configured');
      const p = await ins({ provider: gw.name });
      const r = await gw.createPayment({ payment: p, order });
      const upd = await one(db, 'UPDATE payments SET provider_ref = $2, qr_payload = $3, expires_at = $4, meta = meta || $5 WHERE id = $1 RETURNING *',
        [p.id, r.providerRef, r.qrPayload || null, r.expiresAt || null, { redirectUrl: r.redirectUrl || null }]);
      logger.payment.info('payment.gateway_created', { paymentNo: p.payment_no, provider: gw.name });
      return { payment: upd, confirmNow: false, order };
    }
    throw fail('PAYMENT_FAILED', 'Unsupported payment method');
  });

  if (res.confirmNow) {
    const done = await confirmPayment(ctx, res.payment.id, { source: 'POS', payCardId: res.payCardId, reference: input.reference });
    return done;
  }
  afterCommit(null, () => emitPayment(res.payment, res.order));
  return { payment: res.payment, order: res.order, completed: false };
}

function emitPayment(payment, order, extra = {}) {
  const view = { paymentId: payment.id, paymentNo: payment.payment_no, orderId: order.id, orderNo: order.order_no, status: payment.status, method: payment.method, amount: Number(payment.amount), qrPayload: payment.qr_payload, expiresAt: payment.expires_at, ...extra };
  emit(['staff', `order:${order.id}`, order.member_id && `member:${order.member_id}`], 'payment:update', view);
}

/**
 * Mark a pending payment PAID and fulfil its order — atomically and idempotently.
 * source: POS | STAFF (manual confirm) | WEBHOOK
 */
export async function confirmPayment(ctx, paymentId, { source, payCardId, providerRef, reference } = {}) {
  return tx(async (db) => {
    const payment = await one(db, 'SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
    if (!payment) throw fail('NOT_FOUND', 'Payment not found');
    const order = await one(db, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [payment.order_id]);
    if (payment.status === 'PAID') return { payment, order, completed: true, alreadyProcessed: true };
    if (payment.status !== 'PENDING') throw fail('PAYMENT_NOT_PENDING', `Payment is ${payment.status}`);
    if (order.status !== 'PENDING_PAYMENT') throw fail('CONFLICT', `Order is ${order.status}`);

    // pay-by-card: deduct the wallet first (fails => whole tx rolls back)
    let payTxn = null;
    if (payment.method === 'CARD_BALANCE') {
      const card = await lockCard(db, payCardId || payment.card_id);
      await assertUsable(db, card);
      const items = await many(db, 'SELECT oi.*, p.kind FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE order_id = $1', [order.id]);
      const isFood = items.some((i) => i.kind === 'FOOD');
      payTxn = (await postEntry(db, card, {
        type: isFood ? 'FOOD_PURCHASE' : 'PURCHASE', amount: -Number(payment.amount), ctx, orderId: order.id, paymentId: payment.id,
        merchantId: order.merchant_id, reference: order.order_no, stats: { spend: Number(payment.amount), used: true },
      })).txn;
      if (!order.card_id) { await db.query('UPDATE orders SET card_id = $2, member_id = coalesce(member_id, $3) WHERE id = $1', [order.id, card.id, card.member_id]); order.card_id = card.id; order.member_id = order.member_id || card.member_id; }
      await bumpMemberStats(db, card.member_id, { spend: Number(payment.amount) });
    }

    const paid = await one(db,
      `UPDATE payments SET status = 'PAID', paid_at = now(), confirmed_by = $2, provider_ref = coalesce($3, provider_ref), updated_at = now(),
          meta = meta || $4 WHERE id = $1 RETURNING *`,
      [payment.id, ctx.staff?.id || null, providerRef || null, { confirmedVia: source, ...(reference ? { reference } : {}) }]);
    logger.payment.info('payment.paid', { paymentNo: paid.payment_no, method: paid.method, amount: paid.amount, source });
    const result = await fulfillOrder(db, ctx, order, paid, payTxn);
    afterCommit(db, () => emitPayment(paid, result.order, { receiptId: result.receipt?.id, completed: true }));
    return { payment: paid, ...result, completed: true };
  });
}

async function fulfillOrder(db, ctx, order, payment, payTxn) {
  const s = await getSettings(order.branch_id);
  const items = await many(db, 'SELECT oi.*, p.kind AS product_kind FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE order_id = $1 ORDER BY item_type = $2 DESC, id', [order.id, 'CARD_ISSUE']);
  const fctx = { ...ctx, branchId: order.branch_id || ctx.branchId };
  const touchedCards = new Set();
  const touchedMembers = new Set();
  let productNet = 0;

  // 1) card issue first so a top-up in the same order can land on the new card
  for (const it of items.filter((i) => i.item_type === 'CARD_ISSUE')) {
    const memberId = it.meta.memberId || order.member_id || null;
    await issueCard(db, fctx, { cardId: it.card_id, memberId, deposit: Number(it.total), orderId: order.id, paymentId: payment.id, waiveReason: it.meta.waiveReason });
    touchedCards.add(it.card_id);
    if (!order.card_id) { await db.query('UPDATE orders SET card_id = $2 WHERE id = $1', [order.id, it.card_id]); order.card_id = it.card_id; }
  }
  for (const it of items.filter((i) => i.item_type === 'CARD_REPLACEMENT')) {
    await replaceCard(db, fctx, { oldCardId: it.meta.oldCardId, newCardId: it.card_id, reason: it.meta.reason, orderId: order.id });
    touchedCards.add(it.card_id);
  }
  // 2) top-ups
  for (const it of items.filter((i) => i.item_type === 'TOPUP')) {
    const card = await lockCard(db, it.card_id);
    await assertUsable(db, card);
    if (order.member_id && card.member_id !== order.member_id) throw fail('CARD_MEMBER_MISMATCH');
    const pay = Number(it.total);
    const bonus = Number(it.meta.bonus || 0);
    const tier = await getMemberTier(db, card.member_id);
    const earn = await computeEarn(db, { event: 'TOP_UP', amount: pay, card, tier, settings: s, promo: { pointBonus: it.meta.pointBonus || 0, stampBonus: it.meta.stampBonus || 0, pointMult: 1, stampMult: 1 } });
    if (!card.member_id) earn.points = 0;
    const topup = await one(db,
      `INSERT INTO topups(topup_no, order_id, order_item_id, card_id, member_id, package_id, pay_amount, bonus_amount, point_bonus, stamp_bonus, channel, branch_id, staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [await dailyNo(db, 'TOP'), order.id, it.id, card.id, card.member_id, it.package_id, pay, bonus, earn.points, earn.stamps, order.channel, order.branch_id, ctx.staff?.id || null]);
    const { txn } = await postEntry(db, card, {
      type: 'TOP_UP', amount: pay, bonus, points: earn.points, stamps: earn.stamps, ctx: fctx, orderId: order.id, paymentId: payment.id, topupId: topup.id,
      cashAmount: pay, reference: order.order_no, promotions: it.meta.promotions || [],
      meta: { packageBonus: it.meta.packageBonus, tierBonus: it.meta.tierBonus, promoBonus: it.meta.promoBonus, method: payment.method },
      stats: { topup: pay, toppedUp: true, used: true },
    });
    await db.query(`UPDATE topups SET status = 'COMPLETED', completed_at = now(), transaction_id = $2 WHERE id = $1`, [topup.id, txn.id]);
    if (it.package_id) await db.query('UPDATE topup_packages SET used_count = used_count + 1 WHERE id = $1', [it.package_id]);
    if (it.meta.promotions?.length) await recordUsage(db, it.meta.promotions, { memberId: card.member_id, cardId: card.id, orderId: order.id, transactionId: txn.id });
    await bumpMemberStats(db, card.member_id, { topup: pay, points: earn.points, stamps: earn.stamps });
    await autoConvert(db, fctx, card);
    touchedCards.add(card.id);
    if (card.member_id) {
      touchedMembers.add(card.member_id);
      await notify(db, { audience: 'MEMBER', memberId: card.member_id, type: 'TOPUP_SUCCESS', title: 'Top up successful', body: `+฿${(pay + bonus).toFixed(2)} → balance ฿${Number(card.balance).toFixed(2)}`, data: { cardId: card.id, txnNo: txn.txn_no } });
    }
    await audit(db, fctx, { action: 'TOP_UP', targetType: 'card', targetId: card.id, targetLabel: card.card_number, newData: { pay, bonus, balance: Number(card.balance), txnNo: txn.txn_no, orderNo: order.order_no } });
  }
  // 3) products: stock-out + loyalty earn for identified card
  for (const it of items.filter((i) => i.item_type === 'PRODUCT')) {
    productNet += Number(it.total);
    const p = await one(db, 'SELECT * FROM products WHERE id = $1 FOR UPDATE', [it.product_id]);
    if (p.track_stock) {
      if (p.stock < it.qty) throw fail('OUT_OF_STOCK', `${p.name}: only ${p.stock} left`);
      await db.query('UPDATE products SET stock = stock - $2 WHERE id = $1', [p.id, it.qty]);
      await db.query(`INSERT INTO stock_movements(item_kind, product_id, type, qty, stock_before, stock_after, reference, staff_id) VALUES ('PRODUCT',$1,'SALE',$2,$3,$4,$5,$6)`,
        [p.id, -it.qty, p.stock, p.stock - it.qty, order.order_no, ctx.staff?.id || null]);
      if (p.stock - it.qty <= p.low_stock_threshold) await notify(db, { audience: 'ALL_STAFF', type: 'LOW_STOCK', title: `Low stock: ${p.name}`, body: `${p.stock - it.qty} left`, data: { productId: p.id } });
    }
  }
  const loyaltyCardId = payTxn?.card_id || order.card_id;
  if (productNet > 0 && loyaltyCardId) {
    const card = await lockCard(db, loyaltyCardId);
    if (card.status === 'ACTIVE') {
      const tier = await getMemberTier(db, card.member_id);
      const promos = (order.promotions || []).filter((p) => ['POINT_BONUS', 'STAMP_BONUS', 'POINT_MULTIPLIER', 'STAMP_MULTIPLIER'].includes(p.type));
      const fx = { pointBonus: promos.reduce((a, p) => a + (p.points || 0), 0), stampBonus: promos.reduce((a, p) => a + (p.stamps || 0), 0), pointMult: promos.reduce((a, p) => a * (p.multiplier || 1), 1), stampMult: promos.reduce((a, p) => a * (p.multiplier || 1), 1) };
      const earn = await computeEarn(db, { event: 'FOOD', amount: productNet, card, tier, settings: s, promo: fx });
      if (earn.points || earn.stamps) {
        await postEntry(db, card, { type: earn.points ? 'POINT_ADD' : 'STAMP_ADD', points: earn.points, stamps: earn.stamps, ctx: fctx, orderId: order.id, reason: `Earned from ${order.order_no}`, reference: order.order_no });
        await bumpMemberStats(db, card.member_id, { points: earn.points, stamps: earn.stamps });
        await autoConvert(db, fctx, card);
      }
      if (!payTxn) await bumpMemberStats(db, card.member_id, { spend: productNet });
      touchedCards.add(card.id);
      if (card.member_id) touchedMembers.add(card.member_id);
    }
  }
  if (order.member_id) touchedMembers.add(order.member_id);
  for (const m of touchedMembers) await evaluateTier(db, m, fctx);

  const updated = await one(db, `UPDATE orders SET status = 'PAID', paid_at = now() WHERE id = $1 RETURNING *`, [order.id]);
  const receipt = await createReceipt(db, fctx, { type: 'SALE', orderId: order.id });
  afterCommit(db, () => {
    for (const c of touchedCards) emit([`card:${c}`, 'staff'], 'card:update', { cardId: c });
    for (const m of touchedMembers) emit([`member:${m}`], 'member:update', { memberId: m });
    emit(['staff'], 'txn:new', { type: 'ORDER', orderNo: order.order_no, amount: Number(order.grand_total), method: payment.method, branchId: order.branch_id, at: new Date().toISOString() });
  });
  return { order: updated, receipt };
}

export async function cancelOrder(ctx, orderId, reason) {
  return tx(async (db) => {
    const order = await one(db, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!order) throw fail('NOT_FOUND');
    if (order.status !== 'PENDING_PAYMENT') throw fail('CONFLICT', 'Only unpaid orders can be voided — use refund for paid orders');
    await db.query(`UPDATE payments SET status = 'CANCELLED', updated_at = now() WHERE order_id = $1 AND status = 'PENDING'`, [order.id]);
    const upd = await one(db, `UPDATE orders SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = $2 WHERE id = $1 RETURNING *`, [order.id, reason]);
    await audit(db, ctx, { action: 'ORDER_VOID', targetType: 'order', targetId: order.id, targetLabel: order.order_no, reason });
    afterCommit(db, () => emit(['staff', `order:${order.id}`], 'payment:update', { orderId: order.id, status: 'CANCELLED' }));
    return upd;
  });
}

/**
 * Full refund of a paid order: reverses every ledger entry of the order (never deletes),
 * restocks products, refunds the payment (via gateway when applicable), creates a REFUND receipt.
 */
export async function refundOrder(ctx, orderId, { reason, approverId }) {
  return tx(async (db) => {
    const order = await one(db, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!order) throw fail('NOT_FOUND');
    if (order.status !== 'PAID') throw fail('CONFLICT', `Order is ${order.status}`);
    const payment = await one(db, `SELECT * FROM payments WHERE order_id = $1 AND status = 'PAID' FOR UPDATE`, [order.id]);
    const shift = ctx.staff ? await openShiftFor(db, ctx.staff.id) : null;
    const txns = await many(db, `SELECT * FROM transactions WHERE order_id = $1 AND reversal_of IS NULL AND reversed_by IS NULL ORDER BY created_at DESC`, [order.id]);
    const reversals = [];
    for (const t of txns) {
      if (t.type === 'CARD_TRANSFER_IN' || t.type === 'CARD_TRANSFER_OUT') continue; // replacements are not undone by refund
      const r = await reverseTransaction(db, t.id, { ctx, reason: `Refund ${order.order_no}: ${reason}`, approverId, orderId: order.id });
      reversals.push(r.reversal);
      if (t.type === 'TOP_UP') await db.query(`UPDATE topups SET status = 'REFUNDED' WHERE transaction_id = $1`, [t.id]);
      if (t.type === 'CARD_DEPOSIT') {
        const c = await one(db, 'SELECT * FROM cards WHERE id = $1', [t.card_id]);
        if (Number(c.balance) === 0) await db.query(`UPDATE cards SET status = 'INACTIVE', member_id = NULL, deposit_amount = 0, issued_at = NULL WHERE id = $1`, [c.id]);
        else await db.query('UPDATE cards SET deposit_amount = 0 WHERE id = $1', [c.id]);
      }
    }
    const items = await many(db, `SELECT * FROM order_items WHERE order_id = $1 AND item_type = 'PRODUCT'`, [order.id]);
    for (const it of items) {
      const p = await one(db, 'SELECT * FROM products WHERE id = $1 FOR UPDATE', [it.product_id]);
      if (p.track_stock) {
        await db.query('UPDATE products SET stock = stock + $2 WHERE id = $1', [p.id, it.qty]);
        await db.query(`INSERT INTO stock_movements(item_kind, product_id, type, qty, stock_before, stock_after, reference, reason, staff_id) VALUES ('PRODUCT',$1,'RETURN',$2,$3,$4,$5,$6,$7)`,
          [p.id, it.qty, p.stock, p.stock + it.qty, order.order_no, reason, ctx.staff?.id || null]);
      }
      await db.query('UPDATE order_items SET refunded_qty = qty WHERE id = $1', [it.id]);
    }
    if (payment) {
      if (payment.provider !== 'internal') {
        const gw = getGateway(payment.provider);
        const r = await gw.refund({ payment, amount: Number(payment.amount) });
        if (!r.ok) throw fail('PAYMENT_FAILED', 'Gateway refund failed');
      }
      await db.query(`UPDATE payments SET status = 'REFUNDED', updated_at = now() WHERE id = $1`, [payment.id]);
    }
    const refund = await one(db,
      `INSERT INTO refunds(refund_no, order_id, payment_id, amount, method, reason, staff_id, approver_id, branch_id, shift_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [await dailyNo(db, 'RFD'), order.id, payment?.id || null, order.grand_total, payment?.method === 'CARD_BALANCE' ? 'CARD_BALANCE' : payment?.method || 'CASH', reason, ctx.staff?.id || null, approverId || null, order.branch_id, shift?.id || null]);
    await db.query(`UPDATE orders SET status = 'REFUNDED', refunded_amount = grand_total WHERE id = $1`, [order.id]);
    const original = await one(db, `SELECT id FROM receipts WHERE order_id = $1 AND type = 'SALE' ORDER BY created_at LIMIT 1`, [order.id]);
    const receipt = await createReceipt(db, ctx, { type: 'REFUND', orderId: order.id, refundId: refund.id, originalReceiptId: original?.id, extra: { refundNo: refund.refund_no, refundReason: reason, refundAmount: Number(order.grand_total) } });
    await audit(db, ctx, { action: 'REFUND', targetType: 'order', targetId: order.id, targetLabel: order.order_no, oldData: { status: 'PAID' }, newData: { refundNo: refund.refund_no, amount: Number(order.grand_total) }, reason, approverId });
    if (payment?.provider !== 'internal') logger.payment.info('payment.refunded', { paymentNo: payment?.payment_no });
    afterCommit(db, () => {
      for (const r of reversals) emit([`card:${r.card_id}`, 'staff'], 'card:update', { cardId: r.card_id });
      emit(['staff'], 'txn:new', { type: 'REFUND', orderNo: order.order_no, amount: -Number(order.grand_total), at: new Date().toISOString() });
    });
    return { refund, receipt, reversals };
  });
}

/** Refund / reverse a single ledger transaction (e.g. machine malfunction on PLAY). */
export async function refundTransaction(ctx, txnId, { reason, approverId }) {
  return tx(async (db) => {
    const t = await one(db, 'SELECT * FROM transactions WHERE id = $1', [txnId]);
    if (!t) throw fail('NOT_FOUND', 'Transaction not found');
    if (t.order_id && ['TOP_UP', 'FOOD_PURCHASE', 'PURCHASE', 'CARD_DEPOSIT'].includes(t.type)) throw fail('CONFLICT', 'This transaction belongs to an order — refund the order instead');
    if (!['PLAY', 'BALANCE_ADJUSTMENT', 'STAMP_ADD', 'POINT_ADD', 'STAMP_REMOVE', 'POINT_REMOVE', 'PURCHASE', 'FOOD_PURCHASE'].includes(t.type)) throw fail('CONFLICT', `${t.type} cannot be reversed directly`);
    const r = await reverseTransaction(db, txnId, { ctx, reason, approverId, cashAmount: 0 });
    const refund = await one(db, `INSERT INTO refunds(refund_no, transaction_id, amount, method, reason, staff_id, approver_id, branch_id) VALUES ($1,$2,$3,'CARD_BALANCE',$4,$5,$6,$7) RETURNING *`,
      [await dailyNo(db, 'RFD'), t.id, Math.abs(Number(t.amount)), reason, ctx.staff?.id || null, approverId || null, t.branch_id]);
    if (t.member_id && t.type === 'PLAY') await db.query('UPDATE members SET total_spend = total_spend - $2, total_play = greatest(total_play - 1, 0) WHERE id = $1', [t.member_id, Math.abs(Number(t.amount))]);
    const receipt = await createReceipt(db, ctx, { type: 'REFUND', refundId: refund.id, transactionId: r.reversal.id, extra: { refundNo: refund.refund_no, refundReason: reason, refundAmount: Math.abs(Number(t.amount)), originalTxnNo: t.txn_no, cards: [{ number: `********${r.card.card_number.slice(-4)}`, newBalance: Number(r.card.balance), points: r.card.points, stamps: r.card.stamps }] } });
    await audit(db, ctx, { action: 'REFUND', targetType: 'transaction', targetId: t.id, targetLabel: t.txn_no, oldData: { amount: t.amount }, newData: { reversal: r.reversal.txn_no }, reason, approverId });
    afterCommit(db, () => emit([`card:${t.card_id}`, 'staff', t.member_id && `member:${t.member_id}`], 'card:update', { cardId: t.card_id }));
    return { reversal: r.reversal, refund, receipt };
  });
}

/** Gateway webhook — idempotent on (provider, eventId) and on payment status. */
export async function handleGatewayWebhook(provider, evt) {
  const inserted = await one({ query },
    `INSERT INTO payment_events(provider, event_id, event_type, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
    [provider, evt.eventId, evt.status, evt.raw || {}]);
  if (!inserted) { logger.payment.info('webhook.duplicate', { provider, eventId: evt.eventId }); return { duplicate: true }; }
  const payment = await one({ query }, `SELECT * FROM payments WHERE provider = $1 AND (provider_ref = $2 OR payment_no = $3)`, [provider, evt.providerRef || '', evt.paymentNo || '']);
  if (!payment) {
    await query(`UPDATE payment_events SET result = 'PAYMENT_NOT_FOUND' WHERE id = $1`, [inserted.id]);
    logger.payment.warn('webhook.payment_not_found', { provider, eventId: evt.eventId });
    return { ignored: true };
  }
  await query('UPDATE payment_events SET payment_id = $2 WHERE id = $1', [inserted.id, payment.id]);
  if (evt.status === 'PAID') {
    if (Math.round(evt.amount * 100) !== Math.round(Number(payment.amount) * 100)) {
      await query(`UPDATE payment_events SET result = 'AMOUNT_MISMATCH' WHERE id = $1`, [inserted.id]);
      logger.payment.error('webhook.amount_mismatch', { paymentNo: payment.payment_no, expected: payment.amount, got: evt.amount });
      return { error: 'AMOUNT_MISMATCH' };
    }
    const r = await confirmPayment({ branchId: payment.branch_id }, payment.id, { source: 'WEBHOOK', providerRef: evt.providerRef });
    await query(`UPDATE payment_events SET result = $2 WHERE id = $1`, [inserted.id, r.alreadyProcessed ? 'ALREADY_PAID' : 'PAID']);
    return { ok: true, alreadyProcessed: !!r.alreadyProcessed };
  }
  if (['FAILED', 'CANCELLED'].includes(evt.status)) {
    await query(`UPDATE payments SET status = $2, updated_at = now() WHERE id = $1 AND status = 'PENDING'`, [payment.id, evt.status]);
    await query(`UPDATE payment_events SET result = $2 WHERE id = $1`, [inserted.id, evt.status]);
    const order = await one({ query }, 'SELECT * FROM orders WHERE id = $1', [payment.order_id]);
    emitPayment({ ...payment, status: evt.status }, order);
    return { ok: true };
  }
  return { ignored: true };
}

/** Member self top-up from the portal (gateway / PromptPay via gateway). */
export async function createOnlineTopup(member, { cardId, packageId, amount }) {
  const card = await one({ query }, 'SELECT * FROM cards WHERE id = $1', [cardId]);
  if (!card || card.member_id !== member.id) throw fail('CARD_MEMBER_MISMATCH');
  const ctx = { member, branchId: card.branch_id };
  const { order } = await createOrder(ctx, { channel: 'ONLINE', memberId: member.id, cardId: card.id, items: [{ type: 'TOPUP', cardId: card.id, packageId, amount }] });
  const r = await payOrder(ctx, order.id, { method: 'GATEWAY' });
  return r;
}

export async function expireStalePayments() {
  const { rows } = await query(`UPDATE payments SET status = 'CANCELLED', updated_at = now() WHERE status = 'PENDING' AND expires_at IS NOT NULL AND expires_at < now() - interval '30 minutes' RETURNING id`);
  return rows.length;
}

export { getCardById };
