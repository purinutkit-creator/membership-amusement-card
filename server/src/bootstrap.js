// Initial owner + reference data. Owner credentials come ONLY from environment variables
// or the one-time setup token flow — never hard-coded.
import { query, one, tx } from './db/pool.js';
import { ALL_PERMISSIONS, DEFAULT_ROLES } from './lib/permissions.js';
import { hashSecret, randomToken } from './lib/crypto.js';
import { config } from './config.js';
import { logger } from './lib/logger.js';

let runtimeSetupToken = null;
export const getSetupToken = () => config.setupToken || runtimeSetupToken;

const PAYMENT_METHODS = [
  ['CASH', 'Cash', true], ['PROMPTPAY', 'PromptPay', true], ['BANK_TRANSFER', 'Bank Transfer', true], ['CREDIT_CARD', 'Credit Card (EDC)', true],
  ['DEBIT_CARD', 'Debit Card (EDC)', true], ['E_WALLET', 'E-Wallet', true], ['GATEWAY', 'Payment Gateway', true], ['CARD_BALANCE', 'Card Balance', true], ['OTHER', 'Other', false],
];

export async function syncReferenceData() {
  await tx(async (db) => {
    for (const p of ALL_PERMISSIONS) {
      await db.query(`INSERT INTO permissions(code, module, action, description) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description`, [p.code, p.module, p.action, p.description]);
    }
    for (const r of DEFAULT_ROLES) {
      const existing = await one(db, 'SELECT id FROM roles WHERE code = $1', [r.code]);
      if (existing) continue; // never overwrite owner-customised roles
      const role = await one(db, 'INSERT INTO roles(code, name, is_system, max_discount_pct) VALUES ($1,$2,true,$3) RETURNING id', [r.code, r.name, r.maxDiscount]);
      for (const p of r.perms) await db.query('INSERT INTO role_permissions(role_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [role.id, p]);
    }
    // OWNER / SUPER_ADMIN always hold every permission (including ones added in upgrades)
    for (const code of ['OWNER', 'SUPER_ADMIN']) {
      await db.query(`INSERT INTO role_permissions(role_id, permission_code) SELECT r.id, p.code FROM roles r CROSS JOIN permissions p WHERE r.code = $1 ON CONFLICT DO NOTHING`, [code]);
    }
    for (const [i, [code, name, enabled]] of PAYMENT_METHODS.entries()) {
      await db.query('INSERT INTO payment_methods(code, name, enabled, sort) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING', [code, name, enabled, i]);
    }
  });
}

export async function ensureOwner() {
  const owner = await one({ query }, 'SELECT id FROM staff WHERE is_owner = true LIMIT 1');
  if (owner) return;
  const o = config.owner;
  if (o.username && o.password) {
    if (o.password.length < 10) throw new Error('OWNER_PASSWORD must be at least 10 characters');
    if (o.pin && !/^[0-9]{4,6}$/.test(o.pin)) throw new Error('OWNER_PIN must be 4-6 digits');
    await createOwner({ username: o.username, password: o.password, pin: o.pin, employeeCode: o.employeeCode, firstName: o.firstName, email: o.email });
    logger.security.info('setup.owner_created_from_env', { username: o.username });
    return;
  }
  runtimeSetupToken = config.setupToken || randomToken(12);
  if (!config.setupToken) {
    // Printed once to the server console so only someone with server access can claim the system.
    process.stdout.write(`\n=== FIRST-TIME SETUP ===\nNo owner account exists. Open /setup and enter this one-time setup token:\n  ${runtimeSetupToken}\n========================\n\n`);
  }
}

export async function createOwner({ username, password, pin, employeeCode = 'OWNER', firstName = 'Owner', lastName = '', email }) {
  return tx(async (db) => {
    const exists = await one(db, 'SELECT id FROM staff WHERE is_owner = true LIMIT 1');
    if (exists) throw Object.assign(new Error('Owner already exists'), { status: 409 });
    const role = await one(db, `SELECT id FROM roles WHERE code = 'OWNER'`);
    const s = await one(db,
      `INSERT INTO staff(employee_code, username, email, first_name, last_name, password_hash, pin_hash, role_id, is_owner, start_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,CURRENT_DATE) RETURNING id`,
      [employeeCode, username, email || null, firstName, lastName, await hashSecret(password), pin ? await hashSecret(pin) : null, role.id]);
    runtimeSetupToken = null;
    return s;
  });
}
