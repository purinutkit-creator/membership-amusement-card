// PromptPay QR (EMVCo Merchant-Presented QR, Thai PromptPay AID A000000677010111)
const f = (id, value) => `${id}${String(value.length).padStart(2, '0')}${value}`;

export function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function target(idType, value) {
  const v = String(value || '').replace(/[^0-9]/g, '');
  if (idType === 'PHONE') {
    if (!/^0[0-9]{9}$/.test(v)) throw new Error('PromptPay phone must be a 10-digit Thai mobile number');
    return f('01', ('0066' + v.slice(1)).padStart(13, '0'));
  }
  if (idType === 'TAX_ID') {
    if (!/^[0-9]{13}$/.test(v)) throw new Error('PromptPay Tax ID / National ID must be 13 digits');
    return f('02', v);
  }
  if (idType === 'EWALLET') {
    if (!/^[0-9]{15}$/.test(v)) throw new Error('PromptPay e-Wallet ID must be 15 digits');
    return f('03', v);
  }
  throw new Error('Unknown PromptPay ID type');
}

/** Build PromptPay payload. amount omitted => static QR. */
export function promptPayPayload({ idType = 'PHONE', id, amount }) {
  const dynamic = amount != null && Number(amount) > 0;
  let s = f('00', '01') + f('01', dynamic ? '12' : '11') + f('29', f('00', 'A000000677010111') + target(idType, id)) + f('53', '764');
  if (dynamic) s += f('54', Number(amount).toFixed(2));
  s += f('58', 'TH') + '6304';
  return s + crc16(s);
}

export function promptPayFromSettings(pp, amount) {
  const id = pp.idType === 'TAX_ID' ? pp.taxId : pp.idType === 'EWALLET' ? pp.ewalletId : pp.phone;
  if (!id) throw new Error('PromptPay is not configured (Settings > PromptPay)');
  return promptPayPayload({ idType: pp.idType, id, amount: pp.qrType === 'STATIC' ? null : amount });
}
