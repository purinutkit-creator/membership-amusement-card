// Permission catalog: module -> actions. Codes are `${module}.${action}`.
export const PERMISSION_CATALOG = {
  dashboard: { view: 'View dashboard', revenue: 'View revenue figures', owner: 'View owner (all-branch) dashboard' },
  member: { view: 'View members', create: 'Create members', edit: 'Edit members', suspend: 'Suspend / block members', delete: 'Delete members', merge: 'Merge duplicate members', reset_pin: 'Reset member PIN', export: 'Export member data' },
  card: { view: 'View cards', issue: 'Issue cards', replace: 'Replace cards', block: 'Block cards', unblock: 'Unblock cards', adjust_balance: 'Adjust card balance', transfer: 'Transfer balance between cards', batch: 'Generate / import card batches', print: 'Print card details & labels', return: 'Return card & refund deposit' },
  topup: { create: 'Top up cards', cancel: 'Cancel pending top-up', refund: 'Refund top-up' },
  stamp: { add: 'Add stamps', remove: 'Remove stamps', adjust: 'Adjust stamps', convert: 'Convert stamps to points' },
  point: { add: 'Add points', remove: 'Remove points', adjust: 'Adjust points' },
  reward: { view: 'View rewards', manage: 'Manage rewards', redeem: 'Redeem rewards', cancel_redemption: 'Cancel redemption' },
  stock: { manage: 'Stock in / out / adjust' },
  pos: { open: 'Open POS', discount: 'Apply discounts', void: 'Void orders', refund: 'Refund orders', reprint: 'Reprint receipts', shift: 'Open / close shift', cash_movement: 'Cash in / out' },
  transaction: { view: 'View transactions', refund: 'Refund / reverse transactions' },
  payment: { confirm: 'Confirm manual payments (PromptPay / transfer)', manage: 'Manage payment methods' },
  machine: { view: 'View machines', manage: 'Manage machines' },
  promotion: { view: 'View promotions', manage: 'Manage promotions & packages', approve_media: 'Approve generated / uploaded promotion media' },
  product: { view: 'View products', manage: 'Manage products' },
  merchant: { view: 'View merchants', manage: 'Manage merchants' },
  display: { manage: 'Manage displays & playlists' },
  media: { manage: 'Manage media library' },
  device: { view: 'View devices', manage: 'Manage devices' },
  printer: { manage: 'Manage printers' },
  report: { view: 'View reports', export: 'Export reports' },
  audit: { view: 'View audit logs' },
  settings: { view: 'View settings', edit: 'Edit settings' },
  staff: { view: 'View staff', create: 'Create staff', edit: 'Edit staff', delete: 'Delete / suspend staff', permission: 'Manage roles & permissions', reset_credentials: 'Reset staff PIN / password' },
  branch: { manage: 'Manage branches' },
  approval: { approve: 'Approve restricted actions (manager approval)' },
};

export const ALL_PERMISSIONS = Object.entries(PERMISSION_CATALOG).flatMap(([m, actions]) =>
  Object.entries(actions).map(([a, description]) => ({ code: `${m}.${a}`, module: m, action: a, description }))
);
const all = ALL_PERMISSIONS.map((p) => p.code);
const pick = (...prefixes) => all.filter((c) => prefixes.some((p) => (p.endsWith('.') ? c.startsWith(p) : c === p)));

export const DEFAULT_ROLES = [
  { code: 'OWNER', name: 'Owner', perms: all, maxDiscount: 100 },
  { code: 'SUPER_ADMIN', name: 'Super Admin', perms: all, maxDiscount: 100 },
  { code: 'ADMIN', name: 'Admin', perms: all.filter((c) => !['staff.permission', 'branch.manage', 'dashboard.owner'].includes(c)), maxDiscount: 50 },
  { code: 'MANAGER', name: 'Manager', perms: pick('dashboard.view', 'dashboard.revenue', 'member.', 'card.', 'topup.', 'stamp.', 'point.', 'reward.', 'stock.', 'pos.', 'transaction.', 'payment.confirm', 'machine.', 'promotion.view', 'product.', 'merchant.view', 'device.view', 'report.', 'audit.view', 'settings.view', 'staff.view', 'approval.approve', 'display.manage'), maxDiscount: 30 },
  { code: 'SUPERVISOR', name: 'Supervisor', perms: pick('dashboard.view', 'member.view', 'member.create', 'member.edit', 'card.view', 'card.issue', 'card.block', 'card.print', 'card.return', 'topup.create', 'topup.cancel', 'stamp.add', 'stamp.convert', 'point.add', 'reward.view', 'reward.redeem', 'pos.', 'transaction.view', 'payment.confirm', 'machine.view', 'promotion.view', 'product.view', 'report.view', 'approval.approve'), maxDiscount: 20 },
  { code: 'CASHIER', name: 'Cashier', perms: pick('dashboard.view', 'member.view', 'member.create', 'member.edit', 'card.view', 'card.issue', 'card.print', 'card.return', 'topup.create', 'stamp.add', 'stamp.convert', 'reward.view', 'reward.redeem', 'pos.open', 'pos.discount', 'pos.shift', 'pos.cash_movement', 'transaction.view', 'payment.confirm', 'product.view', 'promotion.view'), maxDiscount: 10 },
  { code: 'CUSTOMER_SERVICE', name: 'Customer Service', perms: pick('dashboard.view', 'member.view', 'member.create', 'member.edit', 'card.view', 'card.block', 'card.print', 'stamp.add', 'reward.view', 'reward.redeem', 'transaction.view'), maxDiscount: 0 },
  { code: 'ARCADE_STAFF', name: 'Arcade Staff', perms: pick('dashboard.view', 'card.view', 'stamp.add', 'machine.view', 'member.view'), maxDiscount: 0 },
  { code: 'REDEMPTION_STAFF', name: 'Redemption Staff', perms: pick('dashboard.view', 'card.view', 'member.view', 'reward.view', 'reward.redeem', 'stamp.add', 'stamp.convert', 'stock.manage'), maxDiscount: 0 },
  { code: 'TECHNICIAN', name: 'Technician', perms: pick('dashboard.view', 'machine.', 'device.', 'printer.manage'), maxDiscount: 0 },
  { code: 'ACCOUNTING', name: 'Accounting', perms: pick('dashboard.view', 'dashboard.revenue', 'transaction.view', 'report.', 'audit.view', 'merchant.view'), maxDiscount: 0 },
];
