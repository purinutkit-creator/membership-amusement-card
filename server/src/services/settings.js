import { query, one } from '../db/pool.js';

// Defaults for every settings group. DB values are deep-merged over these.
export const DEFAULT_SETTINGS = {
  general: {
    storeName: 'Smart Play Arcade', companyName: '', address: '', phone: '', email: '', website: '', taxId: '',
    currency: 'THB', currencySymbol: '฿', timezone: 'Asia/Bangkok', language: 'th', businessType: 'AMUSEMENT_ARCADE',
    modules: { arcade: true, food: false, rewards: true, stamps: true, points: true, tiers: true, promotions: true, customerDisplay: true, signage: true },
  },
  branding: { logoMediaId: null, faviconMediaId: null, loginBgMediaId: null },
  theme: { primary: '#6D28D9', secondary: '#0EA5E9', accent: '#F59E0B', background: '#F6F7FB', buttonStyle: 'solid', radius: 14, defaultMode: 'light' },
  fonts: {
    dashboard: { source: 'google', family: 'Noto Sans Thai' },
    pos: { source: 'google', family: 'Noto Sans Thai' },
    member: { source: 'google', family: 'Prompt' },
    display: { source: 'google', family: 'Prompt' },
    terminal: { source: 'google', family: 'Prompt' },
    receipt: { source: 'google', family: 'Sarabun' },
    a4: { source: 'google', family: 'Sarabun' },
    signage: { source: 'google', family: 'Kanit' },
  },
  language: { default: 'th', customerLanguages: ['th', 'en', 'zh'] },
  member: {
    fields: { email: { enabled: true, required: false }, birthday: { enabled: true, required: false }, gender: { enabled: true, required: false }, address: { enabled: false, required: false } },
    customFields: [],
    otpEnabled: false,
  },
  card: {
    length: 12, prefix: '', autoGenerate: true,
    expiration: { mode: 'NONE', value: 0, date: null }, expiredBalancePolicy: 'KEEP',
    deposit: 50, depositRefundable: true, replacementFee: 0, guestCardEnabled: true,
    tapCooldownSec: 3, minBalance: 0,
  },
  wallet: { maxBalance: 100000, minTopup: 20, maxTopup: 50000, lowBalanceThreshold: 50 },
  topup: { allowCustomAmount: true, requireCardVerification: true },
  tier: { autoUpgrade: true, allowDowngrade: false },
  point: { enabled: true, earnAmount: 25, earnPoints: 1, earnOnTopup: false, expiryMonths: 0, tierMultiplier: true, promotionMultiplier: true },
  stamp: { enabled: true, name: 'M-Stamp', iconMediaId: null, conversion: { enabled: true, stamps: 10, points: 100, mode: 'STAFF' }, expiryMonths: 0, maxStamps: 0, tierMultiplier: true },
  reward: { redemptionExpiryHours: 24 },
  arcade: { allowNegative: false },
  promotion: { policy: 'PRIORITY' },
  tax: { vatMode: 'OFF', vatRate: 7, serviceMode: 'OFF', serviceRate: 10 },
  promptpay: { idType: 'PHONE', phone: '', taxId: '', ewalletId: '', merchantName: '', qrType: 'DYNAMIC', expiryMinutes: 10 },
  bank: { bank: '', accountName: '', accountNumber: '', qrMediaId: null, instruction: '' },
  receipt: {
    header: 'Thank you for visiting', footer: 'Please keep this receipt', paperWidth: '80', copies: 1, autoPrint: false,
    showLogo: true, showQr: true, showBarcode: false, showReprintLabel: true, thankYou: 'Thank you! / ขอบคุณค่ะ',
  },
  display: {
    layout: 'SPLIT_50', promotionSide: 'RIGHT', idleTimeoutSec: 30, playlistId: null, background: null,
    languageSelect: true, defaultLanguage: 'th', returnToLanguageSelect: true, sessionTimeoutSec: 120,
    privacyRequired: false, memberPrompt: true, memberInputBy: 'EITHER', animation: 'fade',
  },
  privacy: { requireAtRegistration: true, requireAtDisplay: false },
  security: {
    sessionIdleMinutes: 60, autoLockMinutes: 5, maxFailedLogins: 5, lockoutMinutes: 15, memberSessionDays: 30,
    approvalRequired: ['topup.refund', 'transaction.refund', 'card.adjust_balance', 'stamp.remove', 'point.remove', 'point.adjust', 'pos.void', 'pos.refund', 'member.merge'],
  },
  device: { heartbeatSec: 20, offlineAfterSec: 60, offlineMode: { enabled: false } },
  sound: { enabled: true, tap: null, success: null, error: null, lowBalance: null, paymentSuccess: null },
  notification: { lowBalance: true, machineOffline: true, printerOffline: true, lowStock: true },
  integration: { paymentGateway: 'mock', otpProvider: 'console', aiProvider: 'template' },
  setup: { completed: false, step: 0 },
};

export const SETTING_GROUPS = Object.keys(DEFAULT_SETTINGS);

function deepMerge(base, over) {
  if (Array.isArray(over) || over === null || typeof over !== 'object' || typeof base !== 'object' || base === null || Array.isArray(base)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

let cache = { at: 0, global: null, branch: new Map() };
const TTL = 5000;

export function invalidateSettings() { cache = { at: 0, global: null, branch: new Map() }; }

async function loadRaw(branchId) {
  const { rows } = await query(
    'SELECT key, value, branch_id FROM settings WHERE branch_id IS NULL OR branch_id = $1',
    [branchId || null]
  );
  return rows;
}

/** Effective settings: defaults <- global <- branch overrides. */
export async function getSettings(branchId = null) {
  const cacheKey = branchId || 'global';
  if (Date.now() - cache.at < TTL) {
    const hit = cache.branch.get(cacheKey);
    if (hit) return hit;
  } else {
    cache = { at: Date.now(), global: null, branch: new Map() };
  }
  const rows = await loadRaw(branchId);
  let s = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows.filter((r) => !r.branch_id)) s[r.key] = deepMerge(s[r.key] ?? {}, r.value);
  for (const r of rows.filter((r) => r.branch_id)) s[r.key] = deepMerge(s[r.key] ?? {}, r.value);
  cache.branch.set(cacheKey, s);
  return s;
}

export async function getGroup(group, branchId = null) {
  return (await getSettings(branchId))[group];
}

export async function getStoredGroup(db, group, branchId = null) {
  const r = await one(db, 'SELECT value FROM settings WHERE key = $1 AND branch_id IS NOT DISTINCT FROM $2', [group, branchId]);
  return r?.value ?? null;
}

export async function setGroup(db, group, value, staffId, branchId = null) {
  const existing = await one(db, 'SELECT id FROM settings WHERE key = $1 AND branch_id IS NOT DISTINCT FROM $2', [group, branchId]);
  if (existing) {
    await db.query('UPDATE settings SET value = $1, updated_by = $2, updated_at = now() WHERE id = $3', [value, staffId, existing.id]);
  } else {
    await db.query('INSERT INTO settings(branch_id, key, value, updated_by) VALUES ($1,$2,$3,$4)', [branchId, group, value, staffId]);
  }
  invalidateSettings();
}

/** Public subset safe for unauthenticated pages (branding, theme, fonts, languages). */
export async function publicSettings(branchId = null) {
  const s = await getSettings(branchId);
  return {
    general: { storeName: s.general.storeName, currency: s.general.currency, currencySymbol: s.general.currencySymbol, language: s.general.language, modules: s.general.modules, timezone: s.general.timezone },
    branding: s.branding, theme: s.theme, fonts: s.fonts, language: s.language,
    member: { fields: s.member.fields, customFields: s.member.customFields, otpEnabled: s.member.otpEnabled },
    stamp: { name: s.stamp.name, iconMediaId: s.stamp.iconMediaId, conversion: s.stamp.conversion },
    display: s.display, sound: s.sound, privacy: s.privacy,
    card: { guestCardEnabled: s.card.guestCardEnabled, deposit: s.card.deposit, replacementFee: s.card.replacementFee, depositRefundable: s.card.depositRefundable },
    receipt: s.receipt,
    setup: { completed: s.setup.completed },
  };
}
