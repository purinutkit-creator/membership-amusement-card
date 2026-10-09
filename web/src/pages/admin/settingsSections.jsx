// Config-driven settings forms. Field names support dot paths for nested settings (e.g. "expiration.mode").
import { useEffect, useState } from 'react';
import { Save, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Button, Card, Input, useLoad, useAction, Skeleton, Switch, Select, Table, Badge, Textarea } from '../../components/ui.jsx';
import { FormField } from '../../components/entity.jsx';
import { MediaField } from '../../components/domain.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { applyTheme } from '../../lib/theme.js';

const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const setIn = (o, p, v) => { const ks = p.split('.'); const out = structuredClone(o || {}); let c = out; ks.slice(0, -1).forEach((k) => { c[k] = c[k] && typeof c[k] === 'object' ? c[k] : {}; c = c[k]; }); c[ks.at(-1)] = v; return out; };

const PERMS_APPROVAL = ['topup.refund', 'transaction.refund', 'card.adjust_balance', 'card.transfer', 'stamp.remove', 'point.add', 'point.remove', 'point.adjust', 'pos.void', 'pos.refund', 'member.merge'];
const SURFACES = ['dashboard', 'pos', 'member', 'display', 'terminal', 'receipt', 'a4', 'signage'];
const POPULAR_FONTS = ['Noto Sans Thai', 'Prompt', 'Kanit', 'Sarabun', 'Mitr', 'IBM Plex Sans Thai', 'Bai Jamjuree', 'Chakra Petch', 'Anuphan', 'K2D', 'Inter', 'Poppins', 'Roboto', 'Noto Sans SC'];

export const GROUPS = {
  general: { label: 'General', fields: [
    { name: 'businessType', label: 'Business type', type: 'select', options: [['AMUSEMENT_ARCADE', 'Amusement Arcade'], ['THEME_PARK', 'Theme Park'], ['INDOOR_PLAYGROUND', 'Indoor Playground'], ['FOOD_PARK', 'Food Park'], ['HYBRID', 'Hybrid']].map(([value, label]) => ({ value, label })) },
    { name: 'storeName', label: 'Store name', required: true }, { name: 'companyName', label: 'Company name' }, { name: 'taxId', label: 'Tax ID' }, { name: 'phone', label: 'Phone' },
    { name: 'email', label: 'Email' }, { name: 'website', label: 'Website' }, { name: 'address', label: 'Address', type: 'textarea', full: true },
    { name: 'currency', label: 'Currency', type: 'select', options: ['THB', 'USD', 'SGD', 'MYR', 'CNY', 'EUR'].map((v) => ({ value: v, label: v })) }, { name: 'currencySymbol', label: 'Currency symbol' },
    { name: 'timezone', label: 'Timezone', type: 'select', options: ['Asia/Bangkok', 'Asia/Singapore', 'Asia/Kuala_Lumpur', 'Asia/Shanghai', 'Asia/Tokyo', 'UTC'].map((v) => ({ value: v, label: v })) },
    { name: 'language', label: 'Default language', type: 'select', options: [{ value: 'th', label: 'ไทย' }, { value: 'en', label: 'English' }, { value: 'zh', label: '中文' }] },
    ...['arcade', 'food', 'rewards', 'stamps', 'points', 'tiers', 'promotions', 'customerDisplay', 'signage'].map((m) => ({ name: `modules.${m}`, label: `Module: ${m}`, type: 'switch' })),
  ] },
  branding: { label: 'Branding', fields: [
    { name: 'logoMediaId', label: 'Logo', type: 'media', category: 'LOGO' }, { name: 'faviconMediaId', label: 'Favicon', type: 'media', category: 'LOGO' }, { name: 'loginBgMediaId', label: 'Login background', type: 'media', category: 'BACKGROUND' },
  ] },
  theme: { label: 'Theme', fields: [
    { name: 'primary', label: 'Primary color', type: 'color' }, { name: 'secondary', label: 'Secondary color', type: 'color' }, { name: 'accent', label: 'Accent color', type: 'color' }, { name: 'background', label: 'Background (light mode)', type: 'color' },
    { name: 'buttonStyle', label: 'Button style', type: 'select', options: [{ value: 'solid', label: 'Solid' }, { value: 'outline', label: 'Outline' }, { value: 'soft', label: 'Soft' }] },
    { name: 'radius', label: 'Border radius (px)', type: 'number', min: 0 }, { name: 'defaultMode', label: 'Default mode', type: 'select', options: [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' }] },
  ] },
  language: { label: 'Language', fields: [
    { name: 'default', label: 'Default customer language', type: 'select', options: [{ value: 'th', label: 'ไทย' }, { value: 'en', label: 'English' }, { value: 'zh', label: '中文' }] },
    { name: 'customerLanguages', label: 'Customer languages', type: 'multiselect', options: [{ value: 'th', label: 'ไทย' }, { value: 'en', label: 'English' }, { value: 'zh', label: '中文' }] },
  ] },
  member: { label: 'Member', fields: [
    ...['email', 'birthday', 'gender', 'address'].flatMap((k) => [{ name: `fields.${k}.enabled`, label: `Registration field: ${k}`, type: 'switch' }, { name: `fields.${k}.required`, label: `${k} required`, type: 'switch' }]),
    { name: 'otpEnabled', label: 'Enable OTP (forgot PIN via SMS — needs OTP provider)', type: 'switch' },
    { name: 'customFields', label: 'Custom fields', type: 'custom', full: true, render: ({ value, set }) => <CustomFieldsEditor value={value || []} onChange={set} /> },
  ] },
  card: { label: 'Card', fields: [
    { name: 'prefix', label: 'Card prefix (0–6 digits)', pattern: /^[0-9]{0,6}$/, patternMessage: 'Digits only' }, { name: 'autoGenerate', label: 'Auto-generate card numbers', type: 'switch' },
    { name: 'expiration.mode', label: 'Card expiration', type: 'select', options: [{ value: 'NONE', label: 'No expiration' }, { value: 'DAYS', label: 'X days' }, { value: 'MONTHS', label: 'X months' }, { value: 'DATE', label: 'Specific date' }] },
    { name: 'expiration.value', label: 'Days / months', type: 'number', min: 0, show: (f) => ['DAYS', 'MONTHS'].includes(get(f, 'expiration.mode')) },
    { name: 'expiration.date', label: 'Expiry date', type: 'date', show: (f) => get(f, 'expiration.mode') === 'DATE' },
    { name: 'expiredBalancePolicy', label: 'Balance when card expires', type: 'select', options: [{ value: 'KEEP', label: 'Keep (reactivation restores)' }, { value: 'FORFEIT', label: 'Forfeit (ledgered BALANCE_EXPIRE)' }] },
    { name: 'deposit', label: 'Card deposit (฿)', type: 'money', min: 0 }, { name: 'depositRefundable', label: 'Deposit refundable on return', type: 'switch' },
    { name: 'replacementFee', label: 'Replacement fee (฿)', type: 'money', min: 0 }, { name: 'guestCardEnabled', label: 'Guest / temporary cards', type: 'switch' },
    { name: 'tapCooldownSec', label: 'Duplicate tap cooldown (sec)', type: 'number', min: 0 }, { name: 'minBalance', label: 'Minimum balance (฿)', type: 'money', min: 0 },
  ] },
  wallet: { label: 'Wallet', fields: [{ name: 'maxBalance', label: 'Maximum card balance', type: 'money', min: 0 }, { name: 'minTopup', label: 'Minimum top-up', type: 'money', min: 0 }, { name: 'maxTopup', label: 'Maximum top-up', type: 'money', min: 0 }, { name: 'lowBalanceThreshold', label: 'Low balance alert below', type: 'money', min: 0 }] },
  topup: { label: 'Top Up', fields: [{ name: 'allowCustomAmount', label: 'Allow custom amount', type: 'switch' }, { name: 'requireCardVerification', label: 'Member card must be verified against the identified member', type: 'switch' }] },
  tier: { label: 'Tier', fields: [{ name: 'autoUpgrade', label: 'Automatic tier upgrade', type: 'switch' }, { name: 'allowDowngrade', label: 'Allow automatic downgrade', type: 'switch' }] },
  point: { label: 'Points', fields: [
    { name: 'enabled', label: 'Points enabled', type: 'switch' }, { name: 'earnAmount', label: 'Spend amount (฿)', type: 'money', min: 0, hint: 'e.g. ฿25' }, { name: 'earnPoints', label: '= Points', type: 'number', min: 0, hint: 'e.g. 1 point' },
    { name: 'earnOnTopup', label: 'Also earn on top-up amount', type: 'switch' }, { name: 'expiryMonths', label: 'Expire after months of inactivity (0 = never)', type: 'number', min: 0 },
    { name: 'tierMultiplier', label: 'Apply tier multiplier', type: 'switch' }, { name: 'promotionMultiplier', label: 'Apply promotion multiplier', type: 'switch' },
  ] },
  stamp: { label: 'M-Stamp', fields: [
    { name: 'enabled', label: 'Stamps enabled', type: 'switch' }, { name: 'name', label: 'Stamp name' }, { name: 'iconMediaId', label: 'Stamp icon', type: 'media', category: 'TIER_ICON' },
    { name: 'conversion.enabled', label: 'Stamp → point conversion', type: 'switch' }, { name: 'conversion.stamps', label: 'Stamps', type: 'number', min: 1 }, { name: 'conversion.points', label: '= Points', type: 'number', min: 0 },
    { name: 'conversion.mode', label: 'Conversion mode', type: 'select', options: [{ value: 'AUTO', label: 'Convert automatically' }, { value: 'MEMBER', label: 'Member converts manually' }, { value: 'STAFF', label: 'Staff converts' }] },
    { name: 'expiryMonths', label: 'Expire after months of inactivity (0 = never)', type: 'number', min: 0 }, { name: 'maxStamps', label: 'Maximum stamps per card (0 = unlimited)', type: 'number', min: 0 }, { name: 'tierMultiplier', label: 'Apply tier multiplier', type: 'switch' },
  ] },
  reward: { label: 'Reward', fields: [{ name: 'redemptionExpiryHours', label: 'Redemption code valid (hours)', type: 'number', min: 1 }] },
  arcade: { label: 'Arcade', fields: [{ name: 'allowNegative', label: 'Allow negative balance (not recommended — DB still blocks it)', type: 'switch' }] },
  promotion: { label: 'Promotion', fields: [{ name: 'policy', label: 'When several promotions match', type: 'select', options: [{ value: 'PRIORITY', label: 'Priority — highest priority non-stackable + stackables' }, { value: 'BEST', label: 'Best discount — largest benefit + stackables' }, { value: 'STACK', label: 'Stack all eligible' }] }] },
  tax: { label: 'Tax & Service', fields: [
    { name: 'vatMode', label: 'VAT', type: 'select', options: [{ value: 'OFF', label: 'VAT off' }, { value: 'INCLUSIVE', label: 'VAT inclusive' }, { value: 'EXCLUSIVE', label: 'VAT exclusive' }] }, { name: 'vatRate', label: 'VAT rate %', type: 'number', min: 0, step: '0.01' },
    { name: 'serviceMode', label: 'Service charge', type: 'select', options: [{ value: 'OFF', label: 'Off' }, { value: 'ON', label: 'On' }] }, { name: 'serviceRate', label: 'Service charge % (5 / 10 / custom)', type: 'number', min: 0, step: '0.01' },
  ] },
  promptpay: { label: 'PromptPay', fields: [
    { name: 'idType', label: 'PromptPay ID type', type: 'select', options: [{ value: 'PHONE', label: 'Phone number' }, { value: 'TAX_ID', label: 'Tax ID / National ID' }, { value: 'EWALLET', label: 'E-Wallet ID' }] },
    { name: 'phone', label: 'PromptPay phone (10 digits)', show: (f) => f.idType === 'PHONE', pattern: /^(0[0-9]{9})?$/, patternMessage: 'Must be 10 digits starting with 0' },
    { name: 'taxId', label: 'PromptPay Tax ID (13 digits)', show: (f) => f.idType === 'TAX_ID', pattern: /^([0-9]{13})?$/, patternMessage: 'Must be 13 digits' },
    { name: 'ewalletId', label: 'PromptPay E-Wallet ID (15 digits)', show: (f) => f.idType === 'EWALLET', pattern: /^([0-9]{15})?$/, patternMessage: 'Must be 15 digits' },
    { name: 'merchantName', label: 'Merchant name' }, { name: 'qrType', label: 'QR type', type: 'select', options: [{ value: 'DYNAMIC', label: 'Dynamic (amount in QR)' }, { value: 'STATIC', label: 'Static' }] },
    { name: 'expiryMinutes', label: 'QR expiry (minutes)', type: 'number', min: 1 },
  ] },
  bank: { label: 'Bank Transfer', fields: [{ name: 'bank', label: 'Bank' }, { name: 'accountName', label: 'Account name' }, { name: 'accountNumber', label: 'Account number' }, { name: 'qrMediaId', label: 'Bank QR image', type: 'media', category: 'GENERAL' }, { name: 'instruction', label: 'Instruction', type: 'textarea', full: true }] },
  receipt: { label: 'Receipt', fields: [
    { name: 'header', label: 'Header', type: 'textarea' }, { name: 'footer', label: 'Footer', type: 'textarea' }, { name: 'thankYou', label: 'Thank-you message' },
    { name: 'paperWidth', label: 'Paper width', type: 'select', options: [{ value: '58', label: '58 mm' }, { value: '80', label: '80 mm' }, { value: 'A4', label: 'A4' }] }, { name: 'copies', label: 'Copies', type: 'number', min: 1 },
    { name: 'autoPrint', label: 'Auto print after payment', type: 'switch' }, { name: 'showLogo', label: 'Show logo', type: 'switch' }, { name: 'showQr', label: 'Show QR (digital receipt)', type: 'switch' },
    { name: 'showBarcode', label: 'Show barcode', type: 'switch' }, { name: 'showReprintLabel', label: 'Print "REPRINT" on reprints', type: 'switch' },
  ] },
  display: { label: 'Customer Display', fields: [
    { name: 'layout', label: 'Layout', type: 'select', options: [{ value: 'SPLIT_50', label: '50 / 50 (order | promotion)' }, { value: 'SPLIT_60', label: '60 / 40' }, { value: 'FULL', label: 'Full order (no promotion area)' }] },
    { name: 'promotionSide', label: 'Promotion area', type: 'select', options: [{ value: 'RIGHT', label: 'Right' }, { value: 'LEFT', label: 'Left' }] },
    { name: 'playlistId', label: 'Playlist', type: 'custom', render: ({ value, set }) => <PlaylistSelect value={value} onChange={set} /> },
    { name: 'background', label: 'Background', type: 'media', category: 'BACKGROUND' }, { name: 'animation', label: 'Animation', type: 'select', options: [{ value: 'fade', label: 'Fade' }, { value: 'none', label: 'None' }] },
    { name: 'idleTimeoutSec', label: 'Idle timeout (sec)', type: 'number', min: 5 }, { name: 'sessionTimeoutSec', label: 'Customer session timeout (sec)', type: 'number', min: 10 },
    { name: 'languageSelect', label: 'Show language selection first', type: 'switch' }, { name: 'returnToLanguageSelect', label: 'Return to language select after each session', type: 'switch' },
    { name: 'defaultLanguage', label: 'Default display language', type: 'select', options: [{ value: 'th', label: 'ไทย' }, { value: 'en', label: 'English' }, { value: 'zh', label: '中文' }] },
    { name: 'privacyRequired', label: 'Require privacy consent before interaction', type: 'switch' }, { name: 'memberPrompt', label: 'Ask "Are you a member?"', type: 'switch' },
    { name: 'memberInputBy', label: 'Member phone entered by', type: 'select', options: [{ value: 'CUSTOMER', label: 'Customer' }, { value: 'CASHIER', label: 'Cashier' }, { value: 'EITHER', label: 'Either' }] },
  ] },
  privacy: { label: 'Privacy', fields: [{ name: 'requireAtRegistration', label: 'Require policy acceptance at registration', type: 'switch' }, { name: 'requireAtDisplay', label: 'Require consent on customer display', type: 'switch' }] },
  security: { label: 'Security', fields: [
    { name: 'sessionIdleMinutes', label: 'Session idle timeout (min)', type: 'number', min: 5 }, { name: 'autoLockMinutes', label: 'Auto lock screen after (min, 0 = off)', type: 'number', min: 0 },
    { name: 'maxFailedLogins', label: 'Max failed logins before lockout', type: 'number', min: 3 }, { name: 'lockoutMinutes', label: 'Lockout duration (min)', type: 'number', min: 1 },
    { name: 'memberSessionDays', label: 'Member portal session (days)', type: 'number', min: 1 },
    { name: 'approvalRequired', label: 'Actions requiring manager approval', type: 'multiselect', full: true, options: PERMS_APPROVAL.map((p) => ({ value: p, label: p })) },
  ] },
  device: { label: 'Device', fields: [{ name: 'heartbeatSec', label: 'Heartbeat interval (sec)', type: 'number', min: 5 }, { name: 'offlineAfterSec', label: 'Mark offline after (sec)', type: 'number', min: 15 },
    { name: 'offlineMode.enabled', label: 'Offline transaction queue (disabled: terminals refuse taps while offline)', type: 'switch', hint: 'Kept off — no unsafe offline deductions' }] },
  sound: { label: 'Sound', fields: [{ name: 'enabled', label: 'Sounds enabled', type: 'switch' }, ...['tap', 'success', 'error', 'lowBalance', 'paymentSuccess'].map((k) => ({ name: k, label: `Custom ${k} sound`, type: 'media', kind: 'SOUND', category: 'SOUND' }))] },
  notification: { label: 'Notification', fields: ['lowBalance', 'machineOffline', 'printerOffline', 'lowStock'].map((k) => ({ name: k, label: `Notify: ${k}`, type: 'switch' })) },
  integration: { label: 'Integration', custom: true },
};
for (const g of Object.values(GROUPS)) for (const f of g.fields || []) if (f.type === 'select' && Array.isArray(f.options) && Array.isArray(f.options[0])) f.options = f.options.map(([value, label]) => ({ value, label }));

function PlaylistSelect({ value, onChange }) {
  const st = useLoad(() => api.get('/playlists'), []);
  return <Select label="Playlist" value={value || ''} placeholder="— none —" options={(st.data?.items || []).map((p) => ({ value: p.id, label: p.name }))} onChange={(e) => onChange(e.target.value || null)} />;
}

function CustomFieldsEditor({ value, onChange }) {
  const upd = (i, k, v) => onChange(value.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  return (
    <div className="col">
      <label className="small bold muted">Custom member fields</label>
      {value.map((cf, i) => (
        <div key={i} className="row wrap">
          <input className="input" style={{ width: 160 }} placeholder="key" value={cf.key} onChange={(e) => upd(i, 'key', e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))} />
          <input className="input grow" placeholder="Label" value={cf.label} onChange={(e) => upd(i, 'label', e.target.value)} />
          <select className="input" style={{ width: 130 }} value={cf.type || 'text'} onChange={(e) => upd(i, 'type', e.target.value)}><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option></select>
          <label className="check"><input type="checkbox" checked={!!cf.required} onChange={(e) => upd(i, 'required', e.target.checked)} />Required</label>
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Remove" />
        </div>
      ))}
      <Button size="sm" icon={Plus} onClick={() => onChange([...value, { key: '', label: '', type: 'text', required: false }])}>Add field</Button>
    </div>
  );
}

/** Load + edit + save one settings group (optionally a branch override). */
export function SettingsGroupForm({ group, branchId = null, onSaved, saveLabel = 'Save', hideTitle }) {
  const cfg = GROUPS[group];
  const { refresh, can } = useAuth();
  const st = useLoad(() => api.get(`/settings/${group}${branchId ? `?branchId=${branchId}` : ''}`), [group, branchId]);
  const [form, setForm] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { if (st.data) setForm(st.data.value); }, [st.data]);
  if (cfg?.custom) return group === 'integration' ? <IntegrationInfo /> : null;
  if (!form) return <Skeleton rows={6} />;
  const onChange = (k, v) => { setForm((s) => setIn(s, k, v)); if (group === 'theme') applyTheme(setIn(form, k, v)); };
  const save = async () => {
    for (const f of cfg.fields) { const v = get(form, f.name); if (f.pattern && v && !f.pattern.test(v)) throw new Error(f.patternMessage); }
    await run(() => api.put(`/settings/${group}`, { value: form, branchId }), { success: `${cfg.label} saved` });
    await refresh();
    onSaved?.(form);
  };
  return (
    <div className="col">
      {!hideTitle && <h2>{cfg.label}{branchId && <Badge tone="info">Branch override</Badge>}</h2>}
      <div className="grid g2">
        {cfg.fields.map((f) => (!f.show || f.show(form)) && <div key={f.name} style={f.full ? { gridColumn: '1/-1' } : undefined}><FormField f={f} value={get(form, f.name)} onChange={onChange} form={form} /></div>)}
      </div>
      {can('settings.edit') && <div><Button variant="primary" icon={Save} loading={busy} onClick={() => save().catch(() => {})}>{saveLabel}</Button></div>}
    </div>
  );
}

export function FontsForm({ onSaved }) {
  const { refresh, can } = useAuth();
  const st = useLoad(() => api.get('/settings/fonts'), []);
  const [form, setForm] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { if (st.data) setForm(st.data.value); }, [st.data]);
  if (!form) return <Skeleton />;
  const upd = (s, k, v) => setForm({ ...form, [s]: { ...form[s], [k]: v } });
  return (
    <div className="col">
      <h2>Fonts</h2>
      <div className="alert">Any Google Font family name works (e.g. "Noto Sans Thai", "Kanit"). Or upload .ttf / .otf / .woff / .woff2 and choose Custom.</div>
      <datalist id="gfonts">{POPULAR_FONTS.map((f) => <option key={f} value={f} />)}</datalist>
      <Table rowKey="s" columns={[
        { key: 's', label: 'Surface' },
        { label: 'Source', render: (r) => <select className="input" value={form[r.s]?.source || 'google'} onChange={(e) => upd(r.s, 'source', e.target.value)}><option value="google">Google Fonts</option><option value="custom">Custom upload</option></select> },
        { label: 'Family', render: (r) => <input className="input" list="gfonts" value={form[r.s]?.family || ''} onChange={(e) => upd(r.s, 'family', e.target.value)} /> },
        { label: 'File', render: (r) => form[r.s]?.source === 'custom' ? <MediaField value={form[r.s]?.mediaId} kind="FONT" category="FONT" onChange={(id, m) => setForm({ ...form, [r.s]: { ...form[r.s], mediaId: id, family: form[r.s]?.family || m?.meta?.fontFamily || 'CustomFont' } })} /> : <span className="faint">—</span> },
        { label: 'Preview', render: (r) => <span style={{ fontFamily: `'${form[r.s]?.family}'` }}>สวัสดี Hello 你好 ฿1,234</span> },
      ]} rows={SURFACES.map((s) => ({ s }))} />
      {can('settings.edit') && <div><Button variant="primary" icon={Save} loading={busy} onClick={async () => { await run(() => api.put('/settings/fonts', { value: form }), { success: 'Fonts saved' }); await refresh(); onSaved?.(); }}>Save fonts</Button></div>}
    </div>
  );
}

export function PaymentMethodsForm() {
  const st = useLoad(() => api.get('/payment-methods'), []);
  const [run] = useAction();
  const { can } = useAuth();
  if (!st.data) return <Skeleton />;
  return (
    <div className="col">
      <h2>Payment methods</h2>
      <div className={`alert ${st.data.gateway.configured ? (st.data.gateway.testMode ? 'warning' : 'success') : ''}`}>
        Payment gateway: <b>{st.data.gateway.provider}</b> {st.data.gateway.testMode ? '— TEST MODE (mock adapter, no real money)' : st.data.gateway.configured ? '— live adapter' : '— not configured (set PAYMENT_GATEWAY on the server)'}
      </div>
      <Table rowKey="code" columns={[
        { key: 'name', label: 'Method' }, { key: 'code', label: 'Code', render: (r) => <code>{r.code}</code> },
        { label: 'Confirmation', render: (r) => ({ CASH: 'Immediate', CARD_BALANCE: 'Immediate (ledger debit)', PROMPTPAY: 'Staff confirms / gateway webhook', BANK_TRANSFER: 'Staff confirms slip', GATEWAY: 'Gateway webhook only' }[r.code] || 'Staff enters EDC approval code') },
        { label: 'Enabled', render: (r) => <span className="switch"><input type="checkbox" disabled={!can('payment.manage')} checked={r.enabled} onChange={(e) => run(() => api.put(`/payment-methods/${r.code}`, { enabled: e.target.checked })).then(() => st.reload(true))} /><span /></span> },
      ]} rows={st.data.items} />
    </div>
  );
}

function IntegrationInfo() {
  const st = useLoad(() => api.get('/ai/status').catch(() => ({ copyProvider: 'n/a' })), []);
  const pm = useLoad(() => api.get('/payment-methods'), []);
  return (
    <div className="col">
      <h2>Integrations</h2>
      <Card title="Payment gateway"><div>Provider: <b>{pm.data?.gateway.provider}</b> {pm.data?.gateway.testMode && <Badge tone="warning">TEST MODE</Badge>}</div>
        <p className="small muted">Adapters live in <code>server/src/integrations/payment/</code>. Implement <code>createPayment / parseWebhook / refund</code> and set <code>PAYMENT_GATEWAY</code>. Webhook URL: <code>{location.origin}/api/public/payments/webhook/&lt;provider&gt;</code></p></Card>
      <Card title="AI promotion copy"><div>Provider: <b>{st.data?.copyProvider}</b></div><p className="small muted">Set <code>ANTHROPIC_API_KEY</code> on the server for AI-written copy; otherwise template copy is used. Creatives always require approval before display.</p></Card>
      <Card title="OTP / SMS"><p className="small muted">Set <code>OTP_PROVIDER</code> and register an adapter in <code>server/src/integrations/otp/</code>. Then enable OTP in Settings → Member.</p></Card>
      <Card title="Email receipts"><p className="small muted"><code>EMAIL_PROVIDER=webhook</code> + <code>EMAIL_WEBHOOK_URL</code> relays receipts to your mail service.</p></Card>
      <Card title="Local Print Bridge"><p className="small muted">For LAN / network ESC/POS printers run <code>node bridge/print-bridge.mjs</code> on the POS computer (127.0.0.1:9110).</p></Card>
      <Card title="Machine controller"><p className="small muted">Approved plays emit <code>play:allow</code> to the terminal (Socket.IO room <code>machine:&lt;id&gt;</code>). Optional <code>relayUrl</code> in the device/machine config receives an HTTP POST to pulse a coin relay.</p></Card>
    </div>
  );
}

export function PrivacyPolicies() {
  const st = useLoad(() => api.get('/privacy-policies'), []);
  const [run] = useAction();
  const [draft, setDraft] = useState(null);
  return (
    <div className="col">
      <div className="row between"><h2>Privacy policies & terms</h2><Button icon={Plus} onClick={() => setDraft({ kind: 'PRIVACY', version: '', title: { th: '', en: '', zh: '' }, content: { th: '', en: '', zh: '' } })}>New version</Button></div>
      <Table columns={[{ key: 'kind', label: 'Kind' }, { key: 'version', label: 'Version' }, { label: 'Status', render: (r) => <Badge tone={r.status === 'PUBLISHED' ? 'success' : ''}>{r.status}</Badge> }, { key: 'consents', label: 'Consents', num: true },
        { label: '', render: (r) => <div className="row">{r.status === 'DRAFT' && <><Button size="sm" onClick={() => setDraft(r)}>Edit</Button><Button size="sm" variant="primary" onClick={() => run(() => api.post(`/privacy-policies/${r.id}/publish`), { success: 'Published' }).then(() => st.reload())}>Publish</Button></>}</div> }]}
        rows={st.data?.items || []} />
      {draft && (
        <Card title={draft.id ? `Edit ${draft.kind} v${draft.version}` : 'New policy version'}>
          <div className="grid g2">
            <Select label="Kind" value={draft.kind} disabled={!!draft.id} options={['PRIVACY', 'TERMS', 'PDPA']} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} />
            <Input label="Version" value={draft.version} onChange={(e) => setDraft({ ...draft, version: e.target.value })} />
          </div>
          {['th', 'en', 'zh'].map((l) => <div key={l} className="mt-s"><Input label={`Title (${l})`} value={draft.title?.[l] || ''} onChange={(e) => setDraft({ ...draft, title: { ...draft.title, [l]: e.target.value } })} />
            <Textarea label={`Content (${l})`} value={draft.content?.[l] || ''} onChange={(e) => setDraft({ ...draft, content: { ...draft.content, [l]: e.target.value } })} /></div>)}
          <div className="row mt"><Button onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" onClick={() => run(() => (draft.id ? api.put(`/privacy-policies/${draft.id}`, draft) : api.post('/privacy-policies', draft)), { success: 'Saved' }).then(() => { setDraft(null); st.reload(); })}>Save draft</Button></div>
        </Card>
      )}
    </div>
  );
}

export { Switch };
