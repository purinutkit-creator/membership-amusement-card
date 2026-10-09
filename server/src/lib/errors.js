export class AppError extends Error {
  constructor(code, message, status = 400, details) {
    super(message || code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// Human friendly messages for well-known business errors
export const ERR = {
  CARD_NOT_FOUND: [404, 'Card not found'],
  CARD_BLOCKED: [409, 'Card is blocked'],
  CARD_LOST: [409, 'Card is reported lost'],
  CARD_EXPIRED: [409, 'Card has expired'],
  CARD_REPLACED: [409, 'Card has been replaced'],
  CARD_INACTIVE: [409, 'Card is not activated'],
  CARD_IN_USE: [409, 'Card is already issued'],
  INSUFFICIENT_BALANCE: [409, 'Insufficient balance'],
  INSUFFICIENT_POINTS: [409, 'Insufficient points'],
  INSUFFICIENT_STAMPS: [409, 'Insufficient stamps'],
  MEMBER_NOT_FOUND: [404, 'Member not found'],
  MEMBER_SUSPENDED: [409, 'Member is suspended or blocked'],
  CARD_MEMBER_MISMATCH: [409, 'Card does not belong to member'],
  PHONE_EXISTS: [409, 'Phone number is already registered'],
  PAYMENT_FAILED: [402, 'Payment failed'],
  PAYMENT_NOT_PENDING: [409, 'Payment is not pending'],
  DEVICE_OFFLINE: [503, 'Device offline'],
  DEVICE_BLOCKED: [403, 'Device is blocked'],
  PRINTER_OFFLINE: [503, 'Printer offline'],
  DUPLICATE_TAP: [409, 'Duplicate tap detected'],
  MACHINE_UNAVAILABLE: [409, 'Machine is not available'],
  MACHINE_NOT_FOUND: [404, 'Machine not found'],
  OUT_OF_STOCK: [409, 'Out of stock'],
  NOT_ELIGIBLE: [409, 'Not eligible'],
  REDEMPTION_USED: [409, 'Redemption code already used'],
  REDEMPTION_NOT_FOUND: [404, 'Redemption code not found'],
  REDEMPTION_EXPIRED: [409, 'Redemption code has expired'],
  ALREADY_REVERSED: [409, 'Transaction already refunded / reversed'],
  UNAUTHENTICATED: [401, 'Please sign in'],
  FORBIDDEN: [403, 'You do not have permission for this action'],
  APPROVAL_REQUIRED: [403, 'Manager approval required'],
  INVALID_APPROVAL: [403, 'Approver credentials are invalid or lack permission'],
  INVALID_CREDENTIALS: [401, 'Invalid credentials'],
  ACCOUNT_LOCKED: [423, 'Too many failed attempts. Account temporarily locked'],
  VALIDATION_ERROR: [422, 'Validation failed'],
  NOT_FOUND: [404, 'Not found'],
  CONFLICT: [409, 'Conflict'],
  SHIFT_REQUIRED: [409, 'Please open a cashier shift first'],
  DISCOUNT_LIMIT: [403, 'Discount exceeds your limit'],
  MAX_BALANCE: [409, 'Top-up would exceed the maximum card balance'],
};

export function fail(code, message, details) {
  const [status, msg] = ERR[code] || [400, code];
  return new AppError(code, message || msg, status, details);
}
