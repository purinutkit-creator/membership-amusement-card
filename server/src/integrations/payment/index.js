// Payment Provider Adapter registry.
// An adapter implements:
//   name
//   createPayment({ payment, order, returnUrl }) -> { providerRef, qrPayload?, redirectUrl?, expiresAt? }
//   parseWebhook(req) -> { eventId, providerRef, paymentNo, status: 'PAID'|'FAILED'|'CANCELLED'|'REFUNDED', amount, raw }
//                        (must verify signature and throw on invalid)
//   refund({ payment, amount }) -> { ok, providerRef }
// Card data never touches this server: real gateways use hosted pages / tokenization.
import { mockGateway } from './mock.js';
import { config } from '../../config.js';

const adapters = { mock: mockGateway };

export function registerGateway(adapter) { adapters[adapter.name] = adapter; }

export function getGateway(name = config.payment.gateway) {
  if (!name || name === 'none') return null;
  const a = adapters[name];
  if (!a) throw new Error(`Payment gateway adapter "${name}" is not installed`);
  if (a.name === 'mock' && config.isProd) throw new Error('Mock gateway cannot run in production');
  return a;
}

export function gatewayInfo() {
  const g = (() => { try { return getGateway(); } catch { return null; } })();
  return { configured: !!g, provider: g?.name || 'none', testMode: g?.name === 'mock' };
}
