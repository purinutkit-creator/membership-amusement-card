-- =====================================================================
-- Smart Card Platform — initial schema
-- Money: NUMERIC(14,2) (THB). Points / stamps: INTEGER.
-- Internal IDs: UUID. Public IDs (member_code, card_number, txn_no...) are separate.
-- =====================================================================

CREATE TABLE counters (
  key   TEXT PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------- media
CREATE TABLE media (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT NOT NULL CHECK (kind IN ('IMAGE','VIDEO','FONT','SOUND','DOCUMENT')),
  category      TEXT NOT NULL DEFAULT 'GENERAL',
  filename      TEXT NOT NULL,
  original_name TEXT,
  mime          TEXT NOT NULL,
  size          BIGINT NOT NULL DEFAULT 0,
  url           TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('APPROVED','PENDING_APPROVAL','REJECTED')),
  generated     BOOLEAN NOT NULL DEFAULT FALSE,
  meta          JSONB NOT NULL DEFAULT '{}',
  uploaded_by   UUID,
  approved_by   UUID,
  approved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- branches
CREATE TABLE branches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  logo_media_id UUID REFERENCES media(id) ON DELETE SET NULL,
  address     TEXT,
  phone       TEXT,
  tax_id      TEXT,
  timezone    TEXT NOT NULL DEFAULT 'Asia/Bangkok',
  currency    TEXT NOT NULL DEFAULT 'THB',
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE merchants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_code TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  logo_media_id UUID REFERENCES media(id) ON DELETE SET NULL,
  branch_id     UUID REFERENCES branches(id),
  commission_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- staff / RBAC
CREATE TABLE permissions (
  code        TEXT PRIMARY KEY,
  module      TEXT NOT NULL,
  action      TEXT NOT NULL,
  description TEXT
);

CREATE TABLE roles (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  description      TEXT,
  is_system        BOOLEAN NOT NULL DEFAULT FALSE,
  max_discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (max_discount_pct BETWEEN 0 AND 100),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_id         UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE staff (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_code    TEXT NOT NULL UNIQUE,
  username         TEXT UNIQUE,
  email            TEXT,
  phone            TEXT,
  first_name       TEXT NOT NULL,
  last_name        TEXT NOT NULL DEFAULT '',
  nickname         TEXT,
  profile_media_id UUID REFERENCES media(id) ON DELETE SET NULL,
  password_hash    TEXT,
  pin_hash         TEXT,
  role_id          UUID NOT NULL REFERENCES roles(id),
  branch_id        UUID REFERENCES branches(id),
  merchant_id      UUID REFERENCES merchants(id),
  is_owner         BOOLEAN NOT NULL DEFAULT FALSE,
  status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DELETED')),
  start_date       DATE,
  note             TEXT,
  max_discount_pct NUMERIC(5,2) CHECK (max_discount_pct BETWEEN 0 AND 100),
  failed_attempts  INT NOT NULL DEFAULT 0,
  locked_until     TIMESTAMPTZ,
  last_login_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE VIEW users AS SELECT id, username, email, employee_code, status, is_owner, created_at FROM staff;

CREATE TABLE staff_permissions (
  staff_id        UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  effect          TEXT NOT NULL CHECK (effect IN ('GRANT','DENY')),
  PRIMARY KEY (staff_id, permission_code)
);

-- ---------------------------------------------------------------- devices
CREATE TABLE devices (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code         TEXT NOT NULL UNIQUE,
  type                TEXT NOT NULL CHECK (type IN ('POS','CARD_READER','ARCADE_TERMINAL','CUSTOMER_DISPLAY','PRINTER','KIOSK','TV_DISPLAY','FOOD_TERMINAL')),
  name                TEXT NOT NULL,
  branch_id           UUID REFERENCES branches(id),
  location            TEXT,
  status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED','INACTIVE')),
  online              BOOLEAN NOT NULL DEFAULT FALSE,
  last_online_at      TIMESTAMPTZ,
  ip                  TEXT,
  version             TEXT,
  token_hash          TEXT UNIQUE,
  activation_code     TEXT,
  activation_expires_at TIMESTAMPTZ,
  config              JSONB NOT NULL DEFAULT '{}',
  block_reason        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX devices_activation_code_uq ON devices(activation_code) WHERE activation_code IS NOT NULL;

CREATE TABLE sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   TEXT NOT NULL UNIQUE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('STAFF','MEMBER','DISPLAY')),
  subject_id   UUID NOT NULL,
  branch_id    UUID REFERENCES branches(id),
  device_id    UUID REFERENCES devices(id) ON DELETE SET NULL,
  ip           TEXT,
  user_agent   TEXT,
  locked       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX sessions_subject_idx ON sessions(subject_type, subject_id);

-- ---------------------------------------------------------------- members
CREATE TABLE member_tiers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  rank          INT NOT NULL UNIQUE,
  color         TEXT NOT NULL DEFAULT '#9CA3AF',
  icon_media_id UUID REFERENCES media(id) ON DELETE SET NULL,
  card_theme    JSONB NOT NULL DEFAULT '{}',
  qualification JSONB NOT NULL DEFAULT '{}',
  benefits      JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_code     TEXT NOT NULL UNIQUE,
  phone           TEXT NOT NULL,
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL DEFAULT '',
  nickname        TEXT,
  email           TEXT,
  birthday        DATE,
  gender          TEXT,
  address         TEXT,
  pin_hash        TEXT,
  tier_id         UUID REFERENCES member_tiers(id),
  tier_locked     BOOLEAN NOT NULL DEFAULT FALSE,
  join_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  total_spend     NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_topup     NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_play      INT NOT NULL DEFAULT 0,
  visit_count     INT NOT NULL DEFAULT 0,
  last_visit_date DATE,
  lifetime_points INT NOT NULL DEFAULT 0,
  lifetime_stamps INT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','BLOCKED','MERGED','DELETED')),
  block_reason    TEXT,
  merged_into     UUID REFERENCES members(id),
  custom_fields   JSONB NOT NULL DEFAULT '{}',
  note            TEXT,
  language        TEXT,
  home_branch_id  UUID REFERENCES branches(id),
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_by      UUID REFERENCES staff(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- phone must be unique among live members
CREATE UNIQUE INDEX members_phone_live_uq ON members(phone) WHERE status NOT IN ('MERGED','DELETED');
CREATE INDEX members_name_idx ON members(lower(first_name), lower(last_name));

-- ---------------------------------------------------------------- cards
CREATE TABLE card_batches (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_no   TEXT NOT NULL UNIQUE,
  quantity   INT NOT NULL,
  card_type  TEXT NOT NULL,
  prefix     TEXT,
  note       TEXT,
  created_by UUID REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cards (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_number    CHAR(12) NOT NULL UNIQUE CHECK (card_number ~ '^[0-9]{12}$'),
  rfid_uid       TEXT UNIQUE,
  card_type      TEXT NOT NULL DEFAULT 'MEMBER' CHECK (card_type IN ('MEMBER','GUEST')),
  member_id      UUID REFERENCES members(id),
  status         TEXT NOT NULL DEFAULT 'INACTIVE' CHECK (status IN ('ACTIVE','BLOCKED','LOST','EXPIRED','REPLACED','INACTIVE')),
  balance        NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  points         INT NOT NULL DEFAULT 0 CHECK (points >= 0),
  stamps         INT NOT NULL DEFAULT 0 CHECK (stamps >= 0),
  deposit_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  batch_id       UUID REFERENCES card_batches(id),
  branch_id      UUID REFERENCES branches(id),
  issued_at      TIMESTAMPTZ,
  issued_by      UUID REFERENCES staff(id),
  expires_at     TIMESTAMPTZ,
  last_used_at   TIMESTAMPTZ,
  last_topup_at  TIMESTAMPTZ,
  total_topup    NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_spend    NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_play     INT NOT NULL DEFAULT 0,
  replaced_by    UUID REFERENCES cards(id),
  replaced_from  UUID REFERENCES cards(id),
  block_reason   TEXT,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (card_type = 'GUEST' OR member_id IS NOT NULL OR status = 'INACTIVE' OR status IN ('REPLACED','BLOCKED','LOST','EXPIRED'))
);
CREATE INDEX cards_member_idx ON cards(member_id);

CREATE TABLE card_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id     UUID NOT NULL REFERENCES cards(id),
  member_id   UUID NOT NULL REFERENCES members(id),
  linked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  unlinked_at TIMESTAMPTZ,
  linked_by   UUID REFERENCES staff(id),
  reason      TEXT
);

-- Guard: wallet values on cards may only change inside the ledger service,
-- which sets the transaction-local flag app.ledger_write = 'on'.
CREATE OR REPLACE FUNCTION cards_wallet_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW.balance IS DISTINCT FROM OLD.balance
      OR NEW.points IS DISTINCT FROM OLD.points
      OR NEW.stamps IS DISTINCT FROM OLD.stamps)
     AND coalesce(current_setting('app.ledger_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'WALLET_DIRECT_WRITE_FORBIDDEN: card wallet values may only change through the ledger';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER cards_wallet_guard_trg BEFORE UPDATE ON cards FOR EACH ROW EXECUTE FUNCTION cards_wallet_guard();

CREATE OR REPLACE FUNCTION cards_insert_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW.balance <> 0 OR NEW.points <> 0 OR NEW.stamps <> 0) THEN
    RAISE EXCEPTION 'WALLET_DIRECT_WRITE_FORBIDDEN: new cards start at zero';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER cards_insert_guard_trg BEFORE INSERT ON cards FOR EACH ROW EXECUTE FUNCTION cards_insert_guard();

CREATE TABLE qr_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token      TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL CHECK (kind IN ('CARD_PORTAL','RECEIPT','REDEMPTION')),
  target_id  UUID NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX qr_tokens_target_idx ON qr_tokens(kind, target_id);

-- ---------------------------------------------------------------- catalog
CREATE TABLE topup_packages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  pay_amount      NUMERIC(14,2) NOT NULL CHECK (pay_amount > 0),
  bonus_amount    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (bonus_amount >= 0),
  point_bonus     INT NOT NULL DEFAULT 0,
  stamp_bonus     INT NOT NULL DEFAULT 0,
  start_at        TIMESTAMPTZ,
  end_at          TIMESTAMPTZ,
  member_only     BOOLEAN NOT NULL DEFAULT FALSE,
  tier_ids        UUID[] NOT NULL DEFAULT '{}',
  branch_ids      UUID[] NOT NULL DEFAULT '{}',
  usage_limit     INT,
  per_card_limit  INT,
  used_count      INT NOT NULL DEFAULT 0,
  image_media_id  UUID REFERENCES media(id) ON DELETE SET NULL,
  sort            INT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE machine_categories (
  id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL,
  icon  TEXT,
  sort  INT NOT NULL DEFAULT 0
);

CREATE TABLE machines (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_code   TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  image_media_id UUID REFERENCES media(id) ON DELETE SET NULL,
  category_id    UUID REFERENCES machine_categories(id),
  branch_id      UUID REFERENCES branches(id),
  zone           TEXT,
  location       TEXT,
  price          NUMERIC(14,2) NOT NULL CHECK (price >= 0),
  member_price   NUMERIC(14,2) CHECK (member_price >= 0),
  tier_prices    JSONB NOT NULL DEFAULT '{}',
  happy_hour     JSONB NOT NULL DEFAULT '{"enabled":false}',
  free_play      BOOLEAN NOT NULL DEFAULT FALSE,
  point_earn     INT NOT NULL DEFAULT 0,
  stamp_earn     INT NOT NULL DEFAULT 0,
  credits_per_play INT NOT NULL DEFAULT 1,
  cooldown_sec   INT,
  status         TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','MAINTENANCE','DISABLED','ERROR')),
  online         BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at   TIMESTAMPTZ,
  device_id      UUID REFERENCES devices(id) ON DELETE SET NULL,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                 TEXT UNIQUE,
  barcode             TEXT,
  name                TEXT NOT NULL,
  category            TEXT NOT NULL DEFAULT 'GENERAL',
  kind                TEXT NOT NULL DEFAULT 'FOOD' CHECK (kind IN ('FOOD','MERCHANDISE','SERVICE')),
  merchant_id         UUID REFERENCES merchants(id),
  branch_id           UUID REFERENCES branches(id),
  price               NUMERIC(14,2) NOT NULL CHECK (price >= 0),
  cost                NUMERIC(14,2),
  image_media_id      UUID REFERENCES media(id) ON DELETE SET NULL,
  track_stock         BOOLEAN NOT NULL DEFAULT FALSE,
  stock               INT NOT NULL DEFAULT 0,
  low_stock_threshold INT NOT NULL DEFAULT 0,
  taxable             BOOLEAN NOT NULL DEFAULT TRUE,
  status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  sort                INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rewards (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                 TEXT UNIQUE,
  barcode             TEXT,
  name                TEXT NOT NULL,
  description         TEXT,
  image_media_id      UUID REFERENCES media(id) ON DELETE SET NULL,
  category            TEXT NOT NULL DEFAULT 'GENERAL',
  points_required     INT NOT NULL DEFAULT 0 CHECK (points_required >= 0),
  stamps_required     INT NOT NULL DEFAULT 0 CHECK (stamps_required >= 0),
  stock               INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
  low_stock_threshold INT NOT NULL DEFAULT 0,
  branch_ids          UUID[] NOT NULL DEFAULT '{}',
  tier_ids            UUID[] NOT NULL DEFAULT '{}',
  member_only         BOOLEAN NOT NULL DEFAULT TRUE,
  limit_per_member    INT,
  start_at            TIMESTAMPTZ,
  end_at              TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (points_required > 0 OR stamps_required > 0)
);

CREATE TABLE stock_movements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_kind    TEXT NOT NULL CHECK (item_kind IN ('REWARD','PRODUCT')),
  reward_id    UUID REFERENCES rewards(id),
  product_id   UUID REFERENCES products(id),
  type         TEXT NOT NULL CHECK (type IN ('IN','OUT','ADJUST','REDEEM','SALE','RETURN','CANCEL')),
  qty          INT NOT NULL,
  stock_before INT NOT NULL,
  stock_after  INT NOT NULL,
  reason       TEXT,
  reference    TEXT,
  staff_id     UUID REFERENCES staff(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE VIEW reward_inventory AS SELECT * FROM stock_movements WHERE item_kind = 'REWARD';

CREATE TABLE promotions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT,
  applies_to      TEXT NOT NULL CHECK (applies_to IN ('TOP_UP','PLAY','FOOD','REWARD')),
  effect_type     TEXT NOT NULL CHECK (effect_type IN ('BONUS_AMOUNT','BONUS_PERCENT','DISCOUNT_AMOUNT','DISCOUNT_PERCENT','FIXED_PRICE','FREE_PLAY','POINT_MULTIPLIER','POINT_BONUS','STAMP_BONUS','STAMP_MULTIPLIER')),
  effect_value    NUMERIC(14,2) NOT NULL DEFAULT 0,
  max_benefit     NUMERIC(14,2),
  stackable       BOOLEAN NOT NULL DEFAULT FALSE,
  priority        INT NOT NULL DEFAULT 100,
  start_at        TIMESTAMPTZ,
  end_at          TIMESTAMPTZ,
  usage_limit     INT,
  per_member_limit INT,
  used_count      INT NOT NULL DEFAULT 0,
  media_id        UUID REFERENCES media(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','INACTIVE')),
  created_by      UUID REFERENCES staff(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE promotion_rules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id UUID NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  rule_type    TEXT NOT NULL CHECK (rule_type IN ('MEMBER_ONLY','TIER_IN','MIN_AMOUNT','MIN_PLAYS_TODAY','DAYS_OF_WEEK','TIME_RANGE','BIRTHDAY_MONTH','BRANCH_IN','MACHINE_IN','CATEGORY_IN','MERCHANT_IN','PACKAGE_IN')),
  value        JSONB NOT NULL
);

CREATE TABLE stamp_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  event       TEXT NOT NULL CHECK (event IN ('PLAY','FOOD','TOP_UP')),
  machine_id  UUID REFERENCES machines(id) ON DELETE CASCADE,
  category_id UUID REFERENCES machine_categories(id) ON DELETE CASCADE,
  min_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,
  per_amount  NUMERIC(14,2),
  stamps      INT NOT NULL CHECK (stamps > 0),
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- POS / payments
CREATE TABLE shifts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_no      TEXT NOT NULL UNIQUE,
  branch_id     UUID REFERENCES branches(id),
  staff_id      UUID NOT NULL REFERENCES staff(id),
  device_id     UUID REFERENCES devices(id),
  status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  opening_cash  NUMERIC(14,2) NOT NULL DEFAULT 0,
  expected_cash NUMERIC(14,2),
  actual_cash   NUMERIC(14,2),
  over_short    NUMERIC(14,2),
  note          TEXT,
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,
  closed_by     UUID REFERENCES staff(id)
);
CREATE UNIQUE INDEX shifts_one_open_per_staff ON shifts(staff_id) WHERE status = 'OPEN';

CREATE TABLE shift_cash_movements (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id   UUID NOT NULL REFERENCES shifts(id),
  type       TEXT NOT NULL CHECK (type IN ('CASH_IN','CASH_OUT')),
  amount     NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  reason     TEXT NOT NULL,
  staff_id   UUID REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no        TEXT NOT NULL UNIQUE,
  branch_id       UUID REFERENCES branches(id),
  merchant_id     UUID REFERENCES merchants(id),
  staff_id        UUID REFERENCES staff(id),
  device_id       UUID REFERENCES devices(id),
  shift_id        UUID REFERENCES shifts(id),
  member_id       UUID REFERENCES members(id),
  card_id         UUID REFERENCES cards(id),
  channel         TEXT NOT NULL DEFAULT 'POS' CHECK (channel IN ('POS','ONLINE','KIOSK','TERMINAL')),
  status          TEXT NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK (status IN ('PENDING_PAYMENT','PAID','CANCELLED','REFUNDED','PARTIALLY_REFUNDED')),
  subtotal        NUMERIC(14,2) NOT NULL DEFAULT 0,
  manual_discount NUMERIC(14,2) NOT NULL DEFAULT 0,
  promo_discount  NUMERIC(14,2) NOT NULL DEFAULT 0,
  tier_discount   NUMERIC(14,2) NOT NULL DEFAULT 0,
  vat_mode        TEXT NOT NULL DEFAULT 'OFF' CHECK (vat_mode IN ('OFF','INCLUSIVE','EXCLUSIVE')),
  vat_rate        NUMERIC(5,2) NOT NULL DEFAULT 0,
  vat_amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
  service_rate    NUMERIC(5,2) NOT NULL DEFAULT 0,
  service_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,
  grand_total     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  refunded_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  promotions      JSONB NOT NULL DEFAULT '[]',
  note            TEXT,
  discount_approver_id UUID REFERENCES staff(id),
  cancel_reason   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at         TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ
);
CREATE INDEX orders_created_idx ON orders(created_at);

CREATE TABLE order_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_type   TEXT NOT NULL CHECK (item_type IN ('PRODUCT','TOPUP','CARD_ISSUE','CARD_REPLACEMENT')),
  product_id  UUID REFERENCES products(id),
  package_id  UUID REFERENCES topup_packages(id),
  card_id     UUID REFERENCES cards(id),
  name        TEXT NOT NULL,
  qty         INT NOT NULL CHECK (qty > 0),
  unit_price  NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
  discount    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total       NUMERIC(14,2) NOT NULL,
  taxable     BOOLEAN NOT NULL DEFAULT FALSE,
  meta        JSONB NOT NULL DEFAULT '{}',
  refunded_qty INT NOT NULL DEFAULT 0
);

CREATE TABLE payment_methods (
  code    TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort    INT NOT NULL DEFAULT 0,
  config  JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_no      TEXT NOT NULL UNIQUE,
  order_id        UUID NOT NULL REFERENCES orders(id),
  method          TEXT NOT NULL REFERENCES payment_methods(code),
  provider        TEXT NOT NULL DEFAULT 'internal',
  amount          NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  received_amount NUMERIC(14,2),
  change_amount   NUMERIC(14,2),
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','FAILED','CANCELLED','REFUNDED')),
  provider_ref    TEXT,
  qr_payload      TEXT,
  expires_at      TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,
  confirmed_by    UUID REFERENCES staff(id),
  card_id         UUID REFERENCES cards(id),
  branch_id       UUID REFERENCES branches(id),
  shift_id        UUID REFERENCES shifts(id),
  idempotency_key TEXT UNIQUE,
  meta            JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_order_idx ON payments(order_id);
CREATE UNIQUE INDEX payments_provider_ref_uq ON payments(provider, provider_ref) WHERE provider_ref IS NOT NULL;

CREATE TABLE payment_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  payment_id  UUID REFERENCES payments(id),
  event_type  TEXT,
  payload     JSONB NOT NULL DEFAULT '{}',
  result      TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

CREATE TABLE topups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topup_no        TEXT NOT NULL UNIQUE,
  order_id        UUID REFERENCES orders(id),
  order_item_id   UUID REFERENCES order_items(id),
  card_id         UUID NOT NULL REFERENCES cards(id),
  member_id       UUID REFERENCES members(id),
  package_id      UUID REFERENCES topup_packages(id),
  pay_amount      NUMERIC(14,2) NOT NULL CHECK (pay_amount > 0),
  bonus_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
  point_bonus     INT NOT NULL DEFAULT 0,
  stamp_bonus     INT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED','CANCELLED','REFUNDED')),
  channel         TEXT NOT NULL DEFAULT 'POS',
  branch_id       UUID REFERENCES branches(id),
  staff_id        UUID REFERENCES staff(id),
  transaction_id  UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

-- ---------------------------------------------------------------- redemptions
CREATE TABLE redemptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT NOT NULL UNIQUE,
  reward_id     UUID NOT NULL REFERENCES rewards(id),
  member_id     UUID REFERENCES members(id),
  card_id       UUID NOT NULL REFERENCES cards(id),
  points        INT NOT NULL DEFAULT 0,
  stamps        INT NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','CANCELLED','EXPIRED')),
  channel       TEXT NOT NULL DEFAULT 'PORTAL' CHECK (channel IN ('PORTAL','COUNTER')),
  branch_id     UUID REFERENCES branches(id),
  transaction_id UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  confirmed_at  TIMESTAMPTZ,
  confirmed_by  UUID REFERENCES staff(id),
  cancelled_at  TIMESTAMPTZ,
  cancelled_by  UUID REFERENCES staff(id),
  cancel_reason TEXT
);

-- ---------------------------------------------------------------- LEDGER
CREATE TABLE transactions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  txn_no         TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL CHECK (type IN (
                   'TOP_UP','PLAY','FOOD_PURCHASE','REFUND','BALANCE_ADJUSTMENT','STAMP_ADD','STAMP_REMOVE',
                   'POINT_ADD','POINT_REMOVE','REWARD_REDEMPTION','REDEMPTION_CANCEL','CARD_DEPOSIT','DEPOSIT_REFUND',
                   'CARD_TRANSFER_OUT','CARD_TRANSFER_IN','PROMOTION_BONUS','STAMP_CONVERT','BALANCE_EXPIRE',
                   'POINT_EXPIRE','STAMP_EXPIRE','PURCHASE','REVERSAL')),
  status         TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED')),
  card_id        UUID REFERENCES cards(id),
  member_id      UUID REFERENCES members(id),
  branch_id      UUID REFERENCES branches(id),
  device_id      UUID REFERENCES devices(id),
  staff_id       UUID REFERENCES staff(id),
  approver_id    UUID REFERENCES staff(id),
  machine_id     UUID REFERENCES machines(id),
  merchant_id    UUID REFERENCES merchants(id),
  order_id       UUID REFERENCES orders(id),
  payment_id     UUID REFERENCES payments(id),
  topup_id       UUID REFERENCES topups(id),
  redemption_id  UUID REFERENCES redemptions(id),
  balance_before NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
  bonus          NUMERIC(14,2) NOT NULL DEFAULT 0,
  balance_after  NUMERIC(14,2) NOT NULL DEFAULT 0,
  points_before  INT NOT NULL DEFAULT 0,
  points_delta   INT NOT NULL DEFAULT 0,
  points_after   INT NOT NULL DEFAULT 0,
  stamps_before  INT NOT NULL DEFAULT 0,
  stamps_delta   INT NOT NULL DEFAULT 0,
  stamps_after   INT NOT NULL DEFAULT 0,
  cash_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
  reference      TEXT,
  reason         TEXT,
  reversal_of    UUID REFERENCES transactions(id),
  reversed_by    UUID REFERENCES transactions(id),
  promotions     JSONB NOT NULL DEFAULT '[]',
  meta           JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (balance_after = balance_before + amount + bonus),
  CHECK (points_after = points_before + points_delta),
  CHECK (stamps_after = stamps_before + stamps_delta),
  CHECK (balance_after >= 0 AND points_after >= 0 AND stamps_after >= 0)
);
CREATE INDEX transactions_card_idx ON transactions(card_id, created_at DESC);
CREATE INDEX transactions_member_idx ON transactions(member_id, created_at DESC);
CREATE INDEX transactions_created_idx ON transactions(created_at);
CREATE INDEX transactions_type_idx ON transactions(type, created_at);
CREATE INDEX transactions_machine_idx ON transactions(machine_id, created_at) WHERE machine_id IS NOT NULL;
-- At most one reversal per original transaction
CREATE UNIQUE INDEX transactions_reversal_uq ON transactions(reversal_of) WHERE reversal_of IS NOT NULL;

ALTER TABLE topups ADD CONSTRAINT topups_txn_fk FOREIGN KEY (transaction_id) REFERENCES transactions(id);
ALTER TABLE redemptions ADD CONSTRAINT redemptions_txn_fk FOREIGN KEY (transaction_id) REFERENCES transactions(id);

-- Ledger immutability: no deletes, and the only permitted update is setting reversed_by once.
CREATE OR REPLACE FUNCTION transactions_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LEDGER_IMMUTABLE: transactions cannot be deleted';
  END IF;
  IF OLD.reversed_by IS NOT NULL OR NEW.reversed_by IS NULL
     OR (to_jsonb(NEW) - 'reversed_by') <> (to_jsonb(OLD) - 'reversed_by') THEN
    RAISE EXCEPTION 'LEDGER_IMMUTABLE: transactions cannot be modified';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER transactions_immutable_trg BEFORE UPDATE OR DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION transactions_immutable();

-- Named views for the per-domain ledgers
CREATE VIEW wallets AS SELECT id AS card_id, card_number, balance, points, stamps, status FROM cards;
CREATE VIEW wallet_transactions AS SELECT * FROM transactions WHERE amount <> 0 OR bonus <> 0;
CREATE VIEW point_transactions  AS SELECT * FROM transactions WHERE points_delta <> 0;
CREATE VIEW stamp_transactions  AS SELECT * FROM transactions WHERE stamps_delta <> 0;
CREATE VIEW machine_transactions AS SELECT * FROM transactions WHERE machine_id IS NOT NULL;

CREATE TABLE tap_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  TEXT NOT NULL UNIQUE,
  device_id   UUID REFERENCES devices(id),
  machine_id  UUID REFERENCES machines(id),
  card_id     UUID REFERENCES cards(id),
  result      TEXT NOT NULL,
  http_status INT NOT NULL,
  response    JSONB NOT NULL,
  transaction_id UUID REFERENCES transactions(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tap_requests_card_idx ON tap_requests(card_id, created_at DESC);

CREATE TABLE promotion_usage (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id   UUID NOT NULL REFERENCES promotions(id),
  member_id      UUID REFERENCES members(id),
  card_id        UUID REFERENCES cards(id),
  order_id       UUID REFERENCES orders(id),
  transaction_id UUID REFERENCES transactions(id),
  benefit        NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refunds (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_no       TEXT NOT NULL UNIQUE,
  order_id        UUID REFERENCES orders(id),
  transaction_id  UUID REFERENCES transactions(id),
  payment_id      UUID REFERENCES payments(id),
  amount          NUMERIC(14,2) NOT NULL,
  method          TEXT,
  reason          TEXT NOT NULL,
  staff_id        UUID REFERENCES staff(id),
  approver_id     UUID REFERENCES staff(id),
  branch_id       UUID REFERENCES branches(id),
  shift_id        UUID REFERENCES shifts(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE receipts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no          TEXT NOT NULL,
  branch_id           UUID REFERENCES branches(id),
  type                TEXT NOT NULL CHECK (type IN ('SALE','REFUND','SERVICE')),
  order_id            UUID REFERENCES orders(id),
  refund_id           UUID REFERENCES refunds(id),
  transaction_id      UUID REFERENCES transactions(id),
  original_receipt_id UUID REFERENCES receipts(id),
  data                JSONB NOT NULL,
  print_count         INT NOT NULL DEFAULT 0,
  reprint_count       INT NOT NULL DEFAULT 0,
  email_to            TEXT,
  created_by          UUID REFERENCES staff(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX receipts_no_scope_uq ON receipts(coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), receipt_no);

CREATE TABLE printers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  branch_id   UUID REFERENCES branches(id),
  device_id   UUID REFERENCES devices(id) ON DELETE SET NULL,
  connection  TEXT NOT NULL CHECK (connection IN ('BROWSER','WEBUSB','WEB_BLUETOOTH','WEB_SERIAL','LAN','BRIDGE')),
  address     TEXT,
  paper_width TEXT NOT NULL DEFAULT '80' CHECK (paper_width IN ('58','80','A4')),
  protocol    TEXT NOT NULL DEFAULT 'ESCPOS' CHECK (protocol IN ('ESCPOS','BROWSER')),
  cut_mode    TEXT NOT NULL DEFAULT 'PARTIAL' CHECK (cut_mode IN ('NONE','PARTIAL','FULL')),
  feed_lines  INT NOT NULL DEFAULT 3,
  cash_drawer BOOLEAN NOT NULL DEFAULT FALSE,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  purpose     TEXT NOT NULL DEFAULT 'RECEIPT' CHECK (purpose IN ('RECEIPT','LABEL','A4')),
  status      TEXT NOT NULL DEFAULT 'UNKNOWN',
  last_seen_at TIMESTAMPTZ,
  config      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE device_pairings (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code               CHAR(6) NOT NULL,
  staff_id           UUID NOT NULL REFERENCES staff(id),
  pos_session_id     UUID REFERENCES sessions(id) ON DELETE SET NULL,
  branch_id          UUID REFERENCES branches(id),
  pos_device_id      UUID REFERENCES devices(id),
  display_device_id  UUID REFERENCES devices(id),
  status             TEXT NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','PAIRED','CLOSED','EXPIRED')),
  expires_at         TIMESTAMPTZ NOT NULL,
  paired_at          TIMESTAMPTZ,
  closed_at          TIMESTAMPTZ,
  state              JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX device_pairings_code_waiting_uq ON device_pairings(code) WHERE status = 'WAITING';

CREATE TABLE display_playlists (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  branch_id  UUID REFERENCES branches(id),
  target     TEXT NOT NULL DEFAULT 'ALL' CHECK (target IN ('ALL','TV','CUSTOMER_DISPLAY','TERMINAL')),
  status     TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE display_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id  UUID NOT NULL REFERENCES display_playlists(id) ON DELETE CASCADE,
  item_type    TEXT NOT NULL CHECK (item_type IN ('IMAGE','VIDEO','TEXT')),
  media_id     UUID REFERENCES media(id) ON DELETE CASCADE,
  text_content JSONB,
  duration_sec INT CHECK (duration_sec IS NULL OR duration_sec > 0),
  sort         INT NOT NULL DEFAULT 0,
  start_date   DATE,
  end_date     DATE,
  days_of_week INT[] NOT NULL DEFAULT '{}',
  start_time   TIME,
  end_time     TIME,
  priority     INT NOT NULL DEFAULT 0,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE privacy_policies (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         TEXT NOT NULL CHECK (kind IN ('PRIVACY','TERMS','PDPA')),
  version      TEXT NOT NULL,
  title        JSONB NOT NULL DEFAULT '{}',
  content      JSONB NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  published_at TIMESTAMPTZ,
  created_by   UUID REFERENCES staff(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, version)
);

CREATE TABLE privacy_consents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id   UUID NOT NULL REFERENCES privacy_policies(id),
  member_id   UUID REFERENCES members(id),
  device_id   UUID REFERENCES devices(id),
  pairing_id  UUID REFERENCES device_pairings(id),
  language    TEXT,
  ip          TEXT,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type   TEXT NOT NULL,
  actor_id     UUID,
  actor_name   TEXT,
  actor_role   TEXT,
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  target_label TEXT,
  old_data     JSONB,
  new_data     JSONB,
  reason       TEXT,
  approver_id  UUID,
  device_id    UUID,
  ip           TEXT,
  branch_id    UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs(created_at DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs(target_type, target_id);
CREATE OR REPLACE FUNCTION audit_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'AUDIT_IMMUTABLE'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_immutable_trg BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_immutable();

CREATE TABLE settings (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id  UUID REFERENCES branches(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL,
  updated_by UUID REFERENCES staff(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX settings_scope_key_uq ON settings(coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

CREATE TABLE notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audience   TEXT NOT NULL CHECK (audience IN ('STAFF','MEMBER','BRANCH','ALL_STAFF')),
  staff_id   UUID REFERENCES staff(id),
  member_id  UUID REFERENCES members(id),
  branch_id  UUID REFERENCES branches(id),
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  data       JSONB NOT NULL DEFAULT '{}',
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_member_idx ON notifications(member_id, created_at DESC);
CREATE INDEX notifications_created_idx ON notifications(created_at DESC);

CREATE TABLE notification_reads (
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  staff_id        UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, staff_id)
);

CREATE TABLE otp_requests (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone      TEXT NOT NULL,
  purpose    TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  attempts   INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_generations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id UUID REFERENCES promotions(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  input        JSONB NOT NULL,
  output       JSONB NOT NULL DEFAULT '{}',
  media_ids    UUID[] NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'PREVIEW' CHECK (status IN ('PREVIEW','APPROVED','REJECTED')),
  created_by   UUID REFERENCES staff(id),
  reviewed_by  UUID REFERENCES staff(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
