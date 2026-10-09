// Customer-facing i18n (Customer Display, Member Portal, Card Terminal, Balance Kiosk).
// All customer text MUST come from these keys. Add a language by adding a dictionary.
import { createContext, useCallback, useContext, useMemo, useState } from 'react';

export const LANGS = [
  { code: 'th', label: 'ไทย', flag: '🇹🇭' },
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'zh', label: '中文', flag: '🇨🇳' },
];

const dict = {
  th: {
    'lang.select': 'เลือกภาษา', welcome: 'ยินดีต้อนรับ', 'welcome.to': 'ยินดีต้อนรับสู่ {store}',
    'member.ask': 'คุณเป็นสมาชิกหรือไม่?', yes: 'ใช่', no: 'ไม่ใช่', back: 'ย้อนกลับ', next: 'ถัดไป', confirm: 'ยืนยัน', cancel: 'ยกเลิก', close: 'ปิด', clear: 'ล้าง', done: 'เสร็จสิ้น', retry: 'ลองใหม่', loading: 'กำลังโหลด…', save: 'บันทึก',
    'phone.enter': 'กรอกเบอร์โทรศัพท์', 'phone.label': 'เบอร์โทรศัพท์', 'member.found': 'พบข้อมูลสมาชิก', 'member.notFound': 'ไม่พบสมาชิก', 'member.hello': 'สวัสดีคุณ {name}',
    'card.tap': 'กรุณาแตะบัตร', 'card.tapOrScan': 'แตะบัตร หรือสแกนบาร์โค้ด / QR', 'card.tapToPlay': 'แตะบัตรเพื่อเล่น', 'card.number': 'หมายเลขบัตร', 'card.enterNumber': 'กรอกหมายเลขบัตร 12 หลัก',
    'balance.check': 'ตรวจสอบยอดเงิน', balance: 'ยอดคงเหลือ', points: 'คะแนน', stamps: 'แสตมป์', tier: 'ระดับสมาชิก', status: 'สถานะ', expires: 'หมดอายุ',
    'pay.amount': 'ยอดชำระ', 'pay.promptpay': 'พร้อมเพย์', 'pay.scan': 'สแกน QR เพื่อชำระเงิน', 'pay.success': 'การชำระเงินสำเร็จ', 'pay.waiting': 'รอการชำระเงิน', 'pay.expiresIn': 'QR หมดอายุใน', 'pay.failed': 'การชำระเงินไม่สำเร็จ', 'pay.method': 'วิธีชำระเงิน',
    promotion: 'โปรโมชั่น', promotions: 'โปรโมชั่น', 'privacy.policy': 'นโยบายความเป็นส่วนตัว', 'privacy.terms': 'ข้อกำหนดและเงื่อนไข', 'privacy.pdpa': 'ความยินยอม PDPA', 'privacy.accept': 'ยอมรับ', 'privacy.read': 'กรุณาอ่านและกดยอมรับเพื่อดำเนินการต่อ',
    'order.summary': 'สรุปรายการ', subtotal: 'ยอดรวม', discount: 'ส่วนลด', total: 'ยอดสุทธิ', bonus: 'โบนัส', 'topup': 'เติมเงิน', 'topup.success': 'เติมเงินสำเร็จ', 'newBalance': 'ยอดคงเหลือใหม่', 'currentBalance': 'ยอดคงเหลือปัจจุบัน', package: 'แพ็กเกจ', vat: 'VAT', service: 'ค่าบริการ',
    'play.success': 'เล่นได้เลย!', 'play.approved': 'อนุมัติการเล่น', 'play.deducted': 'ตัดยอด', 'play.remaining': 'ยอดคงเหลือ', 'play.earnedPoints': 'ได้รับคะแนน', 'play.earnedStamps': 'ได้รับแสตมป์', 'play.price': 'ราคา / ครั้ง', 'play.processing': 'กำลังตรวจสอบ…',
    'err.insufficient': 'ยอดเงินไม่เพียงพอ', 'err.required': 'ต้องการ', 'err.cardNotFound': 'ไม่พบบัตร', 'err.cardBlocked': 'บัตรถูกระงับ', 'err.cardExpired': 'บัตรหมดอายุ', 'err.cardLost': 'บัตรถูกแจ้งหาย', 'err.cardReplaced': 'บัตรนี้ถูกเปลี่ยนแล้ว', 'err.cardInactive': 'บัตรยังไม่เปิดใช้งาน',
    'err.duplicate': 'แตะซ้ำ — ระบบไม่ได้ตัดเงินซ้ำ', 'err.machine': 'เครื่องไม่พร้อมใช้งาน', 'err.offline': 'ออฟไลน์ — ไม่สามารถใช้งานได้ชั่วคราว', 'err.generic': 'เกิดข้อผิดพลาด กรุณาลองใหม่', 'err.memberMismatch': 'บัตรนี้ไม่ใช่ของสมาชิกท่านนี้', 'err.memberSuspended': 'บัญชีสมาชิกถูกระงับ',
    'topup.scan': 'สแกนเพื่อเติมเงิน', 'thankyou': 'ขอบคุณที่ใช้บริการ', 'session.timeout': 'กลับสู่หน้าหลักใน {s} วินาที',
    // portal
    'portal.login': 'เข้าสู่ระบบสมาชิก', 'portal.register': 'สมัครสมาชิก', 'portal.pin': 'PIN 6 หลัก', 'portal.pinConfirm': 'ยืนยัน PIN', 'portal.forgot': 'ลืม PIN?', 'portal.noAccount': 'ยังไม่มีบัญชี?', 'portal.haveAccount': 'มีบัญชีแล้ว?',
    'portal.firstName': 'ชื่อ', 'portal.lastName': 'นามสกุล', 'portal.email': 'อีเมล', 'portal.birthday': 'วันเกิด', 'portal.gender': 'เพศ', 'portal.address': 'ที่อยู่', 'gender.MALE': 'ชาย', 'gender.FEMALE': 'หญิง', 'gender.OTHER': 'อื่นๆ', 'gender.UNSPECIFIED': 'ไม่ระบุ',
    'portal.logout': 'ออกจากระบบ', 'portal.home': 'หน้าแรก', 'portal.myCard': 'บัตรของฉัน', 'portal.rewards': 'ของรางวัล', 'portal.history': 'ประวัติ', 'portal.profile': 'โปรไฟล์', 'portal.memberId': 'รหัสสมาชิก',
    'portal.noCard': 'ยังไม่มีบัตร — ติดต่อเคาน์เตอร์เพื่อรับบัตร', 'portal.redeem': 'แลกรางวัล', 'portal.redeemConfirm': 'ยืนยันการแลกรางวัล', 'portal.redeemCode': 'แสดงรหัสนี้ที่เคาน์เตอร์แลกรางวัล', 'portal.notEligible': 'ยังไม่สามารถแลกได้', 'portal.outOfStock': 'สินค้าหมด',
    'portal.myRedemptions': 'รหัสแลกรางวัลของฉัน', 'portal.choosePackage': 'เลือกแพ็กเกจ', 'portal.customAmount': 'จำนวนเงินอื่น', 'portal.payNow': 'ชำระเงิน', 'portal.testMode': 'โหมดทดสอบ — จำลองการชำระเงิน', 'portal.topupUnavailable': 'ยังไม่เปิดให้เติมเงินออนไลน์ กรุณาเติมที่เคาน์เตอร์',
    'portal.all': 'ทั้งหมด', 'portal.play': 'เล่น', 'portal.refund': 'คืนเงิน', 'portal.adjustment': 'ปรับปรุง', 'portal.empty': 'ยังไม่มีรายการ', 'portal.changePin': 'เปลี่ยน PIN', 'portal.currentPin': 'PIN ปัจจุบัน', 'portal.newPin': 'PIN ใหม่',
    'portal.convertStamps': 'แลกแสตมป์เป็นคะแนน', 'portal.nextTier': 'อีกนิดเพื่อเลื่อนเป็น {tier}', 'portal.notifications': 'การแจ้งเตือน', 'portal.consents': 'ความยินยอมของฉัน', 'portal.acceptAll': 'ฉันได้อ่านและยอมรับ', 'portal.cardLogin': 'ยืนยันตัวตนด้วย PIN เพื่อดูข้อมูลบัตร',
    'portal.contactStaff': 'กรุณาติดต่อพนักงานเพื่อรีเซ็ต PIN', 'portal.otpSent': 'ส่งรหัส OTP แล้ว', 'portal.otp': 'รหัส OTP', 'portal.quick': 'เมนูด่วน', 'portal.digitalCard': 'บัตรดิจิทัล', 'portal.receipt': 'ใบเสร็จ',
  },
  en: {
    'lang.select': 'Select language', welcome: 'Welcome', 'welcome.to': 'Welcome to {store}',
    'member.ask': 'Are you a member?', yes: 'Yes', no: 'No', back: 'Back', next: 'Next', confirm: 'Confirm', cancel: 'Cancel', close: 'Close', clear: 'Clear', done: 'Done', retry: 'Try again', loading: 'Loading…', save: 'Save',
    'phone.enter': 'Enter your phone number', 'phone.label': 'Phone number', 'member.found': 'Member found', 'member.notFound': 'Member not found', 'member.hello': 'Hello, {name}',
    'card.tap': 'Please tap your card', 'card.tapOrScan': 'Tap card or scan barcode / QR', 'card.tapToPlay': 'TAP CARD TO PLAY', 'card.number': 'Card number', 'card.enterNumber': 'Enter 12-digit card number',
    'balance.check': 'Check balance', balance: 'Balance', points: 'Points', stamps: 'Stamps', tier: 'Tier', status: 'Status', expires: 'Expires',
    'pay.amount': 'Amount due', 'pay.promptpay': 'PromptPay', 'pay.scan': 'Scan QR to pay', 'pay.success': 'Payment successful', 'pay.waiting': 'Waiting for payment', 'pay.expiresIn': 'QR expires in', 'pay.failed': 'Payment failed', 'pay.method': 'Payment method',
    promotion: 'Promotion', promotions: 'Promotions', 'privacy.policy': 'Privacy Policy', 'privacy.terms': 'Terms & Conditions', 'privacy.pdpa': 'PDPA Consent', 'privacy.accept': 'ACCEPT', 'privacy.read': 'Please read and accept to continue',
    'order.summary': 'Order summary', subtotal: 'Subtotal', discount: 'Discount', total: 'Total', bonus: 'Bonus', topup: 'Top up', 'topup.success': 'Top up successful', newBalance: 'New balance', currentBalance: 'Current balance', package: 'Package', vat: 'VAT', service: 'Service charge',
    'play.success': 'PLAY SUCCESS', 'play.approved': 'PLAY APPROVED', 'play.deducted': 'Amount deducted', 'play.remaining': 'Remaining balance', 'play.earnedPoints': 'Points earned', 'play.earnedStamps': 'Stamps earned', 'play.price': 'Price / play', 'play.processing': 'Checking…',
    'err.insufficient': 'INSUFFICIENT BALANCE', 'err.required': 'Required', 'err.cardNotFound': 'CARD NOT FOUND', 'err.cardBlocked': 'CARD BLOCKED', 'err.cardExpired': 'CARD EXPIRED', 'err.cardLost': 'CARD REPORTED LOST', 'err.cardReplaced': 'CARD REPLACED', 'err.cardInactive': 'CARD NOT ACTIVATED',
    'err.duplicate': 'DUPLICATE TAP DETECTED — not charged again', 'err.machine': 'MACHINE UNAVAILABLE', 'err.offline': 'OFFLINE — temporarily unavailable', 'err.generic': 'Something went wrong, please try again', 'err.memberMismatch': 'CARD DOES NOT BELONG TO MEMBER', 'err.memberSuspended': 'Member account suspended',
    'topup.scan': 'Scan to top up', thankyou: 'Thank you!', 'session.timeout': 'Returning to start in {s}s',
    'portal.login': 'Member sign in', 'portal.register': 'Register', 'portal.pin': '6-digit PIN', 'portal.pinConfirm': 'Confirm PIN', 'portal.forgot': 'Forgot PIN?', 'portal.noAccount': "Don't have an account?", 'portal.haveAccount': 'Already a member?',
    'portal.firstName': 'First name', 'portal.lastName': 'Last name', 'portal.email': 'Email', 'portal.birthday': 'Birthday', 'portal.gender': 'Gender', 'portal.address': 'Address', 'gender.MALE': 'Male', 'gender.FEMALE': 'Female', 'gender.OTHER': 'Other', 'gender.UNSPECIFIED': 'Prefer not to say',
    'portal.logout': 'Sign out', 'portal.home': 'Home', 'portal.myCard': 'My Card', 'portal.rewards': 'Rewards', 'portal.history': 'History', 'portal.profile': 'Profile', 'portal.memberId': 'Member ID',
    'portal.noCard': 'No card yet — visit the counter to get one', 'portal.redeem': 'Redeem', 'portal.redeemConfirm': 'Confirm redemption', 'portal.redeemCode': 'Show this code at the prize counter', 'portal.notEligible': 'Not eligible yet', 'portal.outOfStock': 'Out of stock',
    'portal.myRedemptions': 'My redemption codes', 'portal.choosePackage': 'Choose a package', 'portal.customAmount': 'Other amount', 'portal.payNow': 'Pay now', 'portal.testMode': 'TEST MODE — simulate payment', 'portal.topupUnavailable': 'Online top-up is not available yet. Please top up at the counter.',
    'portal.all': 'All', 'portal.play': 'Play', 'portal.refund': 'Refund', 'portal.adjustment': 'Adjustment', 'portal.empty': 'Nothing here yet', 'portal.changePin': 'Change PIN', 'portal.currentPin': 'Current PIN', 'portal.newPin': 'New PIN',
    'portal.convertStamps': 'Convert stamps to points', 'portal.nextTier': 'Keep going to reach {tier}', 'portal.notifications': 'Notifications', 'portal.consents': 'My consents', 'portal.acceptAll': 'I have read and accept', 'portal.cardLogin': 'Verify with your PIN to view this card',
    'portal.contactStaff': 'Please contact our staff to reset your PIN', 'portal.otpSent': 'OTP code sent', 'portal.otp': 'OTP code', 'portal.quick': 'Quick actions', 'portal.digitalCard': 'Digital card', 'portal.receipt': 'Receipt',
  },
  zh: {
    'lang.select': '选择语言', welcome: '欢迎', 'welcome.to': '欢迎光临 {store}',
    'member.ask': '您是会员吗？', yes: '是', no: '否', back: '返回', next: '下一步', confirm: '确认', cancel: '取消', close: '关闭', clear: '清除', done: '完成', retry: '重试', loading: '加载中…', save: '保存',
    'phone.enter': '请输入手机号码', 'phone.label': '手机号码', 'member.found': '已找到会员', 'member.notFound': '未找到会员', 'member.hello': '您好，{name}',
    'card.tap': '请刷卡', 'card.tapOrScan': '刷卡或扫描条码 / 二维码', 'card.tapToPlay': '刷卡开始游戏', 'card.number': '卡号', 'card.enterNumber': '请输入12位卡号',
    'balance.check': '查询余额', balance: '余额', points: '积分', stamps: '印章', tier: '会员等级', status: '状态', expires: '有效期至',
    'pay.amount': '应付金额', 'pay.promptpay': 'PromptPay', 'pay.scan': '扫描二维码付款', 'pay.success': '支付成功', 'pay.waiting': '等待付款', 'pay.expiresIn': '二维码剩余时间', 'pay.failed': '支付失败', 'pay.method': '支付方式',
    promotion: '促销', promotions: '促销活动', 'privacy.policy': '隐私政策', 'privacy.terms': '条款与条件', 'privacy.pdpa': '个人数据同意书', 'privacy.accept': '同意', 'privacy.read': '请阅读并同意以继续',
    'order.summary': '订单摘要', subtotal: '小计', discount: '折扣', total: '合计', bonus: '赠送', topup: '充值', 'topup.success': '充值成功', newBalance: '新余额', currentBalance: '当前余额', package: '套餐', vat: '增值税', service: '服务费',
    'play.success': '游戏开始！', 'play.approved': '已批准', 'play.deducted': '扣除金额', 'play.remaining': '剩余余额', 'play.earnedPoints': '获得积分', 'play.earnedStamps': '获得印章', 'play.price': '每次价格', 'play.processing': '验证中…',
    'err.insufficient': '余额不足', 'err.required': '需要', 'err.cardNotFound': '未找到该卡', 'err.cardBlocked': '卡已冻结', 'err.cardExpired': '卡已过期', 'err.cardLost': '卡已挂失', 'err.cardReplaced': '卡已更换', 'err.cardInactive': '卡未激活',
    'err.duplicate': '重复刷卡 — 未重复扣款', 'err.machine': '机器暂不可用', 'err.offline': '离线 — 暂时无法使用', 'err.generic': '发生错误，请重试', 'err.memberMismatch': '此卡不属于该会员', 'err.memberSuspended': '会员账户已暂停',
    'topup.scan': '扫码充值', thankyou: '谢谢惠顾！', 'session.timeout': '{s}秒后返回首页',
    'portal.login': '会员登录', 'portal.register': '注册会员', 'portal.pin': '6位PIN码', 'portal.pinConfirm': '确认PIN码', 'portal.forgot': '忘记PIN码？', 'portal.noAccount': '还没有账户？', 'portal.haveAccount': '已有账户？',
    'portal.firstName': '名', 'portal.lastName': '姓', 'portal.email': '电子邮件', 'portal.birthday': '生日', 'portal.gender': '性别', 'portal.address': '地址', 'gender.MALE': '男', 'gender.FEMALE': '女', 'gender.OTHER': '其他', 'gender.UNSPECIFIED': '不愿透露',
    'portal.logout': '退出登录', 'portal.home': '首页', 'portal.myCard': '我的卡', 'portal.rewards': '奖品', 'portal.history': '记录', 'portal.profile': '个人资料', 'portal.memberId': '会员编号',
    'portal.noCard': '还没有卡 — 请到柜台领取', 'portal.redeem': '兑换', 'portal.redeemConfirm': '确认兑换', 'portal.redeemCode': '请在兑奖柜台出示此码', 'portal.notEligible': '暂不符合兑换条件', 'portal.outOfStock': '已兑完',
    'portal.myRedemptions': '我的兑换码', 'portal.choosePackage': '选择套餐', 'portal.customAmount': '其他金额', 'portal.payNow': '立即支付', 'portal.testMode': '测试模式 — 模拟付款', 'portal.topupUnavailable': '暂未开放在线充值，请到柜台充值。',
    'portal.all': '全部', 'portal.play': '游戏', 'portal.refund': '退款', 'portal.adjustment': '调整', 'portal.empty': '暂无记录', 'portal.changePin': '修改PIN码', 'portal.currentPin': '当前PIN码', 'portal.newPin': '新PIN码',
    'portal.convertStamps': '印章兑换积分', 'portal.nextTier': '继续努力升级为 {tier}', 'portal.notifications': '通知', 'portal.consents': '我的同意记录', 'portal.acceptAll': '我已阅读并同意', 'portal.cardLogin': '请输入PIN码查看此卡信息',
    'portal.contactStaff': '请联系工作人员重置PIN码', 'portal.otpSent': '验证码已发送', 'portal.otp': '验证码', 'portal.quick': '快捷功能', 'portal.digitalCard': '电子会员卡', 'portal.receipt': '收据',
  },
};

export const ERROR_KEY = {
  INSUFFICIENT_BALANCE: 'err.insufficient', CARD_NOT_FOUND: 'err.cardNotFound', CARD_BLOCKED: 'err.cardBlocked', CARD_EXPIRED: 'err.cardExpired', CARD_LOST: 'err.cardLost',
  CARD_REPLACED: 'err.cardReplaced', CARD_INACTIVE: 'err.cardInactive', DUPLICATE_TAP: 'err.duplicate', MACHINE_UNAVAILABLE: 'err.machine', DEVICE_OFFLINE: 'err.offline',
  CARD_MEMBER_MISMATCH: 'err.memberMismatch', MEMBER_SUSPENDED: 'err.memberSuspended', MEMBER_NOT_FOUND: 'member.notFound', PAYMENT_FAILED: 'pay.failed',
};

export function translate(lang, key, vars) {
  let s = dict[lang]?.[key] ?? dict.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}

const Ctx = createContext({ lang: 'th', setLang: () => {}, t: (k) => k });

/** storageKey=null keeps the language in memory only (customer display sessions). */
export function I18nProvider({ children, initial, storageKey = 'sc.lang' }) {
  const [lang, setLangState] = useState(() => (storageKey && localStorage.getItem(storageKey)) || initial || 'th');
  const setLang = useCallback((l) => { setLangState(l); if (storageKey) localStorage.setItem(storageKey, l); document.documentElement.lang = l; }, [storageKey]);
  const t = useCallback((k, v) => translate(lang, k, v), [lang]);
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useI18n = () => useContext(Ctx);

export function LanguageSwitcher({ compact }) {
  const { lang, setLang } = useI18n();
  return (
    <div className="chips" role="group" aria-label="Language">
      {LANGS.map((l) => (
        <button key={l.code} type="button" className={`chip ${lang === l.code ? 'active' : ''}`} onClick={() => setLang(l.code)}>
          {compact ? l.code.toUpperCase() : `${l.flag} ${l.label}`}
        </button>
      ))}
    </div>
  );
}
