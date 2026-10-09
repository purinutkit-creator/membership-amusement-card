// DEVELOPMENT / DEMO SEED DATA — refuses to run in production.
// All money movements go through the real services (orders, ledger, tap) so seeded data is
// fully consistent with the ledger.
import { config } from '../config.js';
import { pool, tx, one, query } from './pool.js';
import { migrate } from './migrate.js';
import { syncReferenceData, createOwner } from '../bootstrap.js';
import { hashSecret, randomToken, sha256 } from '../lib/crypto.js';
import { setGroup, invalidateSettings } from '../services/settings.js';
import { createMember } from '../services/members.js';
import { createCards, ensurePortalToken } from '../services/cards.js';
import { createOrder, payOrder } from '../services/orders.js';
import { openShift } from '../services/shifts.js';
import { processTap } from '../services/tap.js';
import { loadStaff } from '../services/auth.js';
import { changeStamps } from '../services/loyalty.js';

if (config.isProd) { console.error('Refusing to seed demo data in production.'); process.exit(1); }

const log = (...a) => console.log('[seed]', ...a);

async function main() {
  await migrate();
  await syncReferenceData();
  const existing = await one({ query }, 'SELECT count(*)::int AS n FROM branches');
  if (existing.n > 0 && !process.argv.includes('--force')) { log('Data already present — skipping (use --force on an empty DB).'); return; }

  const creds = [];
  const ownerPw = config.owner.password || `Dev-${randomToken(6)}`;
  const ownerPin = config.owner.pin || '123456';
  const ownerExists = await one({ query }, 'SELECT id FROM staff WHERE is_owner LIMIT 1');
  if (!ownerExists) {
    await createOwner({ username: config.owner.username || 'owner', password: ownerPw, pin: ownerPin, employeeCode: 'OWNER', firstName: 'Demo', lastName: 'Owner' });
    creds.push(['Owner', config.owner.username || 'owner', ownerPw, 'OWNER', ownerPin]);
  }

  const ids = await tx(async (db) => {
    const branch = await one(db, `INSERT INTO branches(code, name, address, phone, tax_id) VALUES ('MAIN','Smart Play — Central','99 Rama 9 Rd, Bangkok 10310','02-000-0000','0105550000001') RETURNING *`);
    const branch2 = await one(db, `INSERT INTO branches(code, name, address, phone) VALUES ('BKK2','Smart Play — Riverside','1 Charoen Krung Rd, Bangkok','02-111-1111') RETURNING *`);
    await db.query(`UPDATE staff SET branch_id = $1 WHERE is_owner`, [branch.id]);
    const role = async (code) => (await one(db, 'SELECT id FROM roles WHERE code = $1', [code])).id;
    const staff = [
      ['M001', 'manager', 'Mana', 'Manager', 'MANAGER', '111111'],
      ['C001', 'cashier', 'Chai', 'Cashier', 'CASHIER', '222222'],
      ['A001', null, 'Arun', 'Arcade', 'ARCADE_STAFF', '333333'],
      ['R001', null, 'Rin', 'Redeem', 'REDEMPTION_STAFF', '444444'],
    ];
    for (const [code, username, fn, ln, r, pin] of staff) {
      const pw = username ? `Dev-${randomToken(6)}` : null;
      await db.query(`INSERT INTO staff(employee_code, username, first_name, last_name, role_id, branch_id, password_hash, pin_hash, start_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_DATE)`,
        [code, username, fn, ln, await role(r), branch.id, pw ? await hashSecret(pw) : null, await hashSecret(pin)]);
      creds.push([r, username || '-', pw || '-', code, pin]);
    }

    const tiers = {};
    for (const [code, name, rank, color, q, b] of [
      ['BRONZE', 'Bronze', 0, '#B45309', {}, { pointMultiplier: 1, description: 'Welcome tier' }],
      ['SILVER', 'Silver', 1, '#9CA3AF', { mode: 'ANY', minTopup: 2000, minPoints: 500 }, { topupBonusPct: 2, pointMultiplier: 1.2, description: '+2% top-up bonus' }],
      ['GOLD', 'Gold', 2, '#D4A017', { mode: 'ANY', minTopup: 10000, minPoints: 2500 }, { topupBonusPct: 5, discountPct: 5, pointMultiplier: 1.5, stampMultiplier: 2, birthdayPoints: 200, description: '+5% bonus, 5% food discount, x2 stamps' }],
      ['PLATINUM', 'Platinum', 3, '#475569', { mode: 'ANY', minTopup: 30000 }, { topupBonusPct: 8, discountPct: 8, pointMultiplier: 2, stampMultiplier: 2, birthdayPoints: 500 }],
      ['VIP', 'VIP', 4, '#7C3AED', { mode: 'ANY', minTopup: 80000 }, { topupBonusPct: 10, discountPct: 10, pointMultiplier: 3, stampMultiplier: 3, birthdayPoints: 1000 }],
    ]) tiers[code] = await one(db, 'INSERT INTO member_tiers(code, name, rank, color, qualification, benefits) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [code, name, rank, color, q, b]);

    for (const [i, [name, pay, bonus, pb, sb]] of [['฿100', 100, 0, 0, 0], ['฿300 + Bonus ฿30', 300, 30, 0, 1], ['฿500 + Bonus ฿80', 500, 80, 20, 2], ['฿1,000 + Bonus ฿200', 1000, 200, 50, 5]].entries()) {
      await db.query('INSERT INTO topup_packages(name, pay_amount, bonus_amount, point_bonus, stamp_bonus, sort) VALUES ($1,$2,$3,$4,$5,$6)', [name, pay, bonus, pb, sb, i]);
    }

    const cats = {};
    for (const [i, [code, name, icon]] of [['RACING', 'Racing', 'car'], ['SHOOTING', 'Shooting', 'crosshair'], ['CRANE', 'Crane / Prize', 'gift'], ['SPORTS', 'Sports', 'trophy'], ['KIDS', 'Kids Rides', 'baby'], ['VR', 'VR Premium', 'glasses']].entries()) {
      cats[code] = await one(db, 'INSERT INTO machine_categories(code, name, icon, sort) VALUES ($1,$2,$3,$4) RETURNING *', [code, name, icon, i]);
    }
    const machines = [];
    for (const [code, name, cat, zone, price, memberPrice, pts, st] of [
      ['RC-01', 'Turbo Racer DX', 'RACING', 'A', 40, 35, 4, 1], ['RC-02', 'Moto GP Rush', 'RACING', 'A', 40, null, 4, 1],
      ['SH-01', 'Zombie Hunter', 'SHOOTING', 'B', 50, 45, 5, 1], ['CR-01', 'Mega Claw', 'CRANE', 'C', 20, null, 2, 1],
      ['SP-01', 'Basket Mania', 'SPORTS', 'C', 30, null, 3, 1], ['KD-01', 'Happy Carousel', 'KIDS', 'D', 25, null, 2, 1],
      ['VR-01', 'VR Space Mission', 'VR', 'E', 120, 100, 15, 3],
    ]) {
      const dev = await one(db, `INSERT INTO devices(device_code, type, name, branch_id, location) VALUES ($1,'ARCADE_TERMINAL',$2,$3,$4) RETURNING *`, [`TERM-${code}`, `Terminal ${name}`, branch.id, `Zone ${zone}`]);
      machines.push(await one(db, `INSERT INTO machines(machine_code, name, category_id, branch_id, zone, price, member_price, point_earn, stamp_earn, device_id, tier_prices, happy_hour)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [code, name, cats[cat].id, branch.id, zone, price, memberPrice, pts, st, dev.id,
        code === 'VR-01' ? { [tiers.GOLD.id]: 90, [tiers.VIP.id]: 80 } : {}, code === 'RC-01' ? { enabled: true, days: [1, 2, 3, 4, 5], start: '10:00', end: '15:00', price: 30 } : { enabled: false }]));
    }
    await db.query(`INSERT INTO devices(device_code, type, name, branch_id, location) VALUES ('POS-01','POS','Front Counter POS',$1,'Counter'), ('KIOSK-01','KIOSK','Balance Check Kiosk',$1,'Entrance'), ('TV-01','TV_DISPLAY','Lobby TV',$1,'Lobby')`, [branch.id]);

    await db.query(`INSERT INTO stamp_rules(name, event, min_amount, per_amount, stamps) VALUES ('Food ฿100 = 1 stamp','FOOD',100,100,1), ('Top up ฿500 = 5 stamps','TOP_UP',500,NULL,5)`);
    await db.query(`INSERT INTO stamp_rules(name, event, category_id, stamps) VALUES ('VR premium bonus','PLAY',$1,2)`, [cats.VR.id]);

    const promo = async (name, applies, effect, value, rules, extra = {}) => {
      const p = await one(db, `INSERT INTO promotions(name, applies_to, effect_type, effect_value, status, priority, stackable, description) VALUES ($1,$2,$3,$4,'ACTIVE',$5,$6,$7) RETURNING *`,
        [name, applies, effect, value, extra.priority ?? 100, extra.stackable ?? false, extra.description || null]);
      for (const [t, v] of rules) await db.query('INSERT INTO promotion_rules(promotion_id, rule_type, value) VALUES ($1,$2,$3)', [p.id, t, JSON.stringify(v)]);
    };
    await promo('Gold Weekend Top-up +10%', 'TOP_UP', 'BONUS_PERCENT', 10, [['TIER_IN', [tiers.GOLD.id, tiers.PLATINUM.id, tiers.VIP.id]], ['DAYS_OF_WEEK', [0, 6]], ['MIN_AMOUNT', 500]], { description: 'Gold+ members get +10% bonus on weekends (min ฿500)' });
    await promo('Birthday Month Free Play', 'PLAY', 'DISCOUNT_PERCENT', 50, [['BIRTHDAY_MONTH', true], ['MEMBER_ONLY', true]], { description: '50% off every play in your birthday month' });
    await promo('5th Play Bonus Stamps', 'PLAY', 'STAMP_BONUS', 2, [['MIN_PLAYS_TODAY', 5]], { stackable: true, description: '+2 stamps from your 5th play of the day' });
    await promo('Lunch Combo 10% off', 'FOOD', 'DISCOUNT_PERCENT', 10, [['TIME_RANGE', { start: '11:00', end: '14:00' }], ['MIN_AMOUNT', 150]]);

    for (const [sku, name, cat, pts, st, stock] of [['RW-001', 'Keychain', 'TOY', 100, 0, 200], ['RW-002', 'Plush Bear', 'TOY', 800, 0, 40], ['RW-003', 'Free Play Voucher', 'VOUCHER', 0, 10, 500], ['RW-004', 'Bluetooth Speaker', 'ELECTRONICS', 5000, 0, 5], ['RW-005', 'Soft Drink', 'FOOD', 150, 0, 100]]) {
      await db.query(`INSERT INTO rewards(sku, name, category, points_required, stamps_required, stock, low_stock_threshold, member_only, description) VALUES ($1,$2,$3,$4,$5,$6,3,$7,$8)`, [sku, name, cat, pts, st, stock, st === 0, `${name} — redeem at the prize counter`]);
    }

    const mA = await one(db, `INSERT INTO merchants(merchant_code, name, branch_id, commission_pct) VALUES ('FD01','Noodle House',$1,15) RETURNING *`, [branch.id]);
    const mB = await one(db, `INSERT INTO merchants(merchant_code, name, branch_id, commission_pct) VALUES ('FD02','Sweet Corner',$1,20) RETURNING *`, [branch.id]);
    for (const [sku, name, cat, kind, price, mid, track, stock] of [
      ['F-001', 'Pad Thai', 'MAIN', 'FOOD', 89, mA.id, false, 0], ['F-002', 'Tom Yum Noodle', 'MAIN', 'FOOD', 95, mA.id, false, 0], ['F-003', 'Iced Thai Tea', 'DRINK', 'FOOD', 45, mB.id, false, 0],
      ['F-004', 'Mango Sticky Rice', 'DESSERT', 'FOOD', 79, mB.id, false, 0], ['F-005', 'Popcorn', 'SNACK', 'FOOD', 59, null, true, 120], ['M-001', 'Arcade T-Shirt', 'MERCH', 'MERCHANDISE', 299, null, true, 30],
    ]) await db.query('INSERT INTO products(sku, name, category, kind, price, merchant_id, track_stock, stock, branch_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [sku, name, cat, kind, price, mid, track, stock, branch.id]);

    const content = (th, en, zh) => ({ th, en, zh });
    for (const [kind, title, body] of [
      ['PRIVACY', content('นโยบายความเป็นส่วนตัว', 'Privacy Policy', '隐私政策'), content('เราเก็บและใช้ข้อมูลส่วนบุคคลของคุณ (ชื่อ เบอร์โทรศัพท์ ประวัติการใช้งาน) เพื่อให้บริการสมาชิก สะสมคะแนน และติดต่อเกี่ยวกับโปรโมชั่น ตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 คุณสามารถขอเข้าถึง แก้ไข หรือลบข้อมูลได้ที่เคาน์เตอร์', 'We collect and use your personal data (name, phone, usage history) to provide membership services, loyalty points and promotional contact under Thailand PDPA 2019. You may request access, correction or deletion at the counter.', '我们收集并使用您的个人数据（姓名、电话、使用记录）以提供会员服务、积分及促销联系，符合泰国2019年个人数据保护法。您可在柜台申请查阅、更正或删除。')],
      ['TERMS', content('ข้อกำหนดและเงื่อนไข', 'Terms & Conditions', '条款与条件'), content('ยอดเงินในบัตรไม่สามารถแลกเป็นเงินสดได้ ยกเว้นตามนโยบายการคืนเงินของร้าน กรุณาเก็บรักษาบัตรและ PIN ของคุณ', 'Card balance is non-refundable except under store refund policy. Keep your card and PIN safe.', '卡内余额不可兑换现金，商店退款政策除外。请妥善保管您的卡和PIN。')],
    ]) await db.query(`INSERT INTO privacy_policies(kind, version, title, content, status, published_at) VALUES ($1,'1.0',$2,$3,'PUBLISHED',now())`, [kind, title, body]);

    const pl = await one(db, `INSERT INTO display_playlists(name, branch_id, target) VALUES ('Main Promotions',$1,'ALL') RETURNING *`, [branch.id]);
    for (const [i, [t, s, bg]] of [
      [content('เติม ฿1,000 รับโบนัส ฿200', 'Top up ฿1,000 get ฿200 bonus', '充值 ฿1,000 送 ฿200'), content('ทุกวัน ที่เคาน์เตอร์', 'Every day at the counter', '每天柜台办理'), '#6D28D9'],
      [content('Happy Hour ฿30', 'Happy Hour ฿30', '欢乐时光 ฿30'), content('Turbo Racer จ.-ศ. 10:00-15:00', 'Turbo Racer Mon–Fri 10:00–15:00', 'Turbo Racer 周一至周五 10:00–15:00'), '#0EA5E9'],
      [content('สะสม M-Stamp แลกของรางวัล', 'Collect M-Stamps, win prizes', '集M-Stamp 换奖品'), content('10 แสตมป์ = 100 คะแนน', '10 stamps = 100 points', '10枚印章 = 100积分'), '#F59E0B'],
    ].entries()) await db.query(`INSERT INTO display_items(playlist_id, item_type, text_content, duration_sec, sort) VALUES ($1,'TEXT',$2,8,$3)`, [pl.id, { title: t, subtitle: s, background: bg }, i]);

    await db.query(`INSERT INTO printers(name, branch_id, connection, paper_width, protocol, is_default) VALUES ('Browser Print (80mm)',$1,'BROWSER','80','BROWSER',true)`, [branch.id]);
    return { branch, branch2, machines, tiers, playlistId: pl.id };
  });

  await tx(async (db) => {
    await setGroup(db, 'general', { storeName: 'Smart Play Arcade', companyName: 'Smart Play Co., Ltd.', address: '99 Rama 9 Rd, Bangkok 10310', phone: '02-000-0000', taxId: '0105550000001', businessType: 'HYBRID', modules: { arcade: true, food: true, rewards: true, stamps: true, points: true, tiers: true, promotions: true, customerDisplay: true, signage: true } }, null);
    await setGroup(db, 'promptpay', { idType: 'PHONE', phone: '0812345678', merchantName: 'Smart Play Arcade', qrType: 'DYNAMIC' }, null);
    await setGroup(db, 'display', { playlistId: ids.playlistId }, null);
    await setGroup(db, 'setup', { completed: true, step: 15 }, null);
  });
  invalidateSettings();

  // ---- sample members, cards and real transactions via the services
  const cashier = await loadStaff((await one({ query }, `SELECT id FROM staff WHERE employee_code = 'C001'`)).id);
  const ctx = { staff: cashier, branchId: ids.branch.id, ip: '127.0.0.1' };
  await tx((db) => openShift(db, ctx, { openingCash: 2000 }));
  const { cards } = await tx((db) => createCards(db, ctx, { count: 60, cardType: 'MEMBER', note: 'Demo stock' }));
  await tx((db) => createCards(db, ctx, { count: 20, cardType: 'GUEST', note: 'Guest stock' }));
  for (const c of cards) await ensurePortalToken({ query }, c.id);

  const people = [
    ['0811111111', 'Somchai', 'Jaidee', 1000, '1990-03-15'], ['0822222222', 'Suda', 'Rakdee', 500, '1995-11-02'], ['0833333333', 'Anan', 'Meesuk', 300, null],
    ['0844444444', 'Ploy', 'Srisuk', 1000, '2000-07-20'], ['0855555555', 'Wei', 'Chen', 100, null], ['0866666666', 'Emma', 'Smith', 500, null],
  ];
  const pkgs = (await query('SELECT * FROM topup_packages ORDER BY pay_amount')).rows;
  for (const [i, [phone, fn, ln, amount, bday]] of people.entries()) {
    const m = await tx((db) => createMember(db, ctx, { phone, firstName: fn, lastName: ln, pin: '123456', birthday: bday }));
    const card = cards[i];
    const pkg = pkgs.find((p) => Number(p.pay_amount) === amount);
    const { order } = await createOrder(ctx, { memberId: m.id, items: [{ type: 'CARD_ISSUE', cardId: card.id, memberId: m.id }, { type: 'TOPUP', cardId: card.id, packageId: pkg.id }] });
    await payOrder(ctx, order.id, { method: 'CASH', receivedAmount: Number(order.grand_total) });
    log(`member ${fn} ${phone} / PIN 123456 -> card ${card.card_number}`);
  }
  // some plays through the real tap pipeline
  for (const m of ids.machines.slice(0, 5)) {
    const dev = await one({ query }, 'SELECT * FROM devices WHERE id = $1', [m.device_id]);
    for (let i = 0; i < 3; i++) {
      const c = cards[i % 4];
      await processTap({ device: dev, machineId: m.id, cardIdentifier: c.card_number, requestId: `seed-${m.machine_code}-${i}-${randomToken(4)}` });
    }
  }
  await tx((db) => changeStamps(db, ctx, { cardId: cards[0].id, delta: 5, reason: 'Welcome stamps' }));

  // activate demo terminal tokens so the UI can be tried without the activation flow
  const termTokens = [];
  for (const m of ids.machines.slice(0, 3)) {
    const token = randomToken(32);
    await query('UPDATE devices SET token_hash = $2 WHERE id = $1', [m.device_id, sha256(token)]);
    termTokens.push([m.name, m.id, token]);
  }

  console.log('\n================ DEMO CREDENTIALS (development only) ================');
  console.table(creds.map(([role, username, password, code, pin]) => ({ role, username, password, employeeCode: code, pin })));
  console.log('Members: phone 0811111111 … 0866666666, PIN 123456');
  console.log('Demo terminal device tokens (paste in Terminal > "Use device token"):');
  for (const [name, , token] of termTokens) console.log(`  ${name}: ${token}`);
  console.log('======================================================================\n');
}

main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
