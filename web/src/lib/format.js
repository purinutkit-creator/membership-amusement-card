let currencySymbol = '฿';
export function setCurrency(sym) { currencySymbol = sym || '฿'; }
export const money = (n, sym = currencySymbol) => (n == null || n === '' ? '—' : `${Number(n) < 0 ? '-' : ''}${sym}${Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const money0 = (n, sym = currencySymbol) => (n == null ? '—' : `${sym}${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
export const int = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
export const signed = (n, fmt = int) => (Number(n) > 0 ? `+${fmt(n)}` : fmt(n));
export const dt = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const date = (d) => (d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const time = (d) => (d ? new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—');
export const maskCard = (n) => (n ? `•••• •••• ${String(n).slice(-4)}` : '—');
export const groupCard = (n) => (n ? String(n).replace(/(\d{4})(?=\d)/g, '$1 ') : '—');
export const maskPhone = (p) => (p ? `${p.slice(0, 3)}•••${p.slice(-4)}` : '—');
export const fullName = (o) => [o?.first_name ?? o?.firstName, o?.last_name ?? o?.lastName].filter(Boolean).join(' ');
export const STATUS_TONE = {
  ACTIVE: 'success', AVAILABLE: 'success', PAID: 'success', COMPLETED: 'success', CONFIRMED: 'success', APPROVED: 'success', OPEN: 'info', PUBLISHED: 'success',
  PENDING: 'warning', PENDING_PAYMENT: 'warning', PENDING_APPROVAL: 'warning', MAINTENANCE: 'warning', DRAFT: 'warning', WAITING: 'warning', SUSPENDED: 'warning', INACTIVE: '',
  BLOCKED: 'danger', LOST: 'danger', EXPIRED: 'danger', ERROR: 'danger', FAILED: 'danger', CANCELLED: '', REFUNDED: 'info', REPLACED: 'info', DISABLED: 'danger', REJECTED: 'danger', CLOSED: '', DELETED: 'danger', MERGED: 'info',
};
export const TXN_LABEL = {
  TOP_UP: 'Top Up', PLAY: 'Play', FOOD_PURCHASE: 'Food', PURCHASE: 'Purchase', REFUND: 'Refund', BALANCE_ADJUSTMENT: 'Balance Adjust', STAMP_ADD: 'Stamp +', STAMP_REMOVE: 'Stamp −',
  POINT_ADD: 'Point +', POINT_REMOVE: 'Point −', REWARD_REDEMPTION: 'Reward', REDEMPTION_CANCEL: 'Reward Cancel', CARD_DEPOSIT: 'Deposit', DEPOSIT_REFUND: 'Deposit Refund',
  CARD_TRANSFER_OUT: 'Transfer Out', CARD_TRANSFER_IN: 'Transfer In', PROMOTION_BONUS: 'Bonus', STAMP_CONVERT: 'Stamp→Point', BALANCE_EXPIRE: 'Balance Expired', POINT_EXPIRE: 'Points Expired', STAMP_EXPIRE: 'Stamps Expired', REVERSAL: 'Reversal',
};
