import { z } from 'zod';
import { AppError } from './errors.js';

export { z };

export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const details = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new AppError('VALIDATION_ERROR', details.map((d) => `${d.path || 'input'}: ${d.message}`).join('; '), 422, details);
  }
  return r.data;
}

export const zMoney = z.coerce.number().finite().min(0).max(10_000_000).transform((n) => Math.round(n * 100) / 100);
export const zPosMoney = z.coerce.number().finite().gt(0).max(10_000_000).transform((n) => Math.round(n * 100) / 100);
export const zPhone = z.string().trim().transform((s) => s.replace(/[\s-]/g, '')).pipe(z.string().regex(/^\+?[0-9]{9,15}$/, 'Invalid phone number'));
export const zPin6 = z.string().regex(/^[0-9]{6}$/, 'PIN must be 6 digits');
export const zStaffPin = z.string().regex(/^[0-9]{4,6}$/, 'PIN must be 4-6 digits');
export const zUuid = z.string().uuid();
export const zOptUuid = z.string().uuid().nullish().or(z.literal('').transform(() => null));
export const zCardNumber = z.string().regex(/^[0-9]{12}$/, 'Card number must be 12 digits');
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
export const zPage = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export const zReason = z.string().trim().min(3, 'Reason is required').max(500);
