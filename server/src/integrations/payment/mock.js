// TEST-MODE gateway. Generates a PromptPay-format QR but money is never actually collected.
// Payments are completed by calling the signed webhook (the UI exposes a clearly-labelled
// "Simulate payment (TEST MODE)" button outside production).
import { randomToken, hmac, safeEqual } from '../../lib/crypto.js';
import { promptPayPayload } from '../../lib/promptpay.js';
import { config } from '../../config.js';

export const mockGateway = {
  name: 'mock',
  async createPayment({ payment }) {
    return {
      providerRef: `MOCK-${randomToken(9)}`,
      qrPayload: promptPayPayload({ idType: 'PHONE', id: '0000000000', amount: payment.amount }),
      expiresAt: new Date(Date.now() + 10 * 60000),
    };
  },
  sign(body) { return hmac(config.payment.webhookSecret, typeof body === 'string' ? body : JSON.stringify(body)); },
  parseWebhook(req) {
    const sig = req.headers['x-signature'] || '';
    const raw = req.rawBody || JSON.stringify(req.body);
    if (!config.payment.webhookSecret || !safeEqual(sig, hmac(config.payment.webhookSecret, raw))) {
      const e = new Error('Invalid webhook signature'); e.status = 401; throw e;
    }
    const b = req.body;
    return { eventId: String(b.eventId), providerRef: b.providerRef, paymentNo: b.paymentNo, status: b.status, amount: Number(b.amount), raw: b };
  },
  async refund({ payment }) { return { ok: true, providerRef: `MOCKRF-${payment.provider_ref}` }; },
};
