// OTP provider adapter. 'console' is dev-only (prints the code to the server log);
// production must configure a real SMS provider, otherwise OTP features are disabled.
import { config } from '../../config.js';

const providers = {
  console: { name: 'console', async send(phone, code) { if (config.isProd) throw new Error('console OTP not allowed in production'); process.stdout.write(`[DEV OTP] ${phone}: ${code}\n`); } },
};
export function registerOtpProvider(p) { providers[p.name] = p; }
export function getOtpProvider() { return config.otp.provider === 'none' ? null : providers[config.otp.provider] || null; }
