# Smart Card Platform — Arcade · Theme Park · Indoor Playground · Food Park

ระบบบัตรเติมเงิน / สมาชิก / POS แบบครบวงจร (Full-Stack Web App / PWA) สำหรับ Amusement Arcade, Game Center,
Theme Park, Indoor Playground และ Food Park — ทุกปุ่มเชื่อมฐานข้อมูลจริง ทุกการเปลี่ยนยอดเงินผ่าน Ledger ที่ตรวจสอบย้อนหลังได้

A single-codebase, production-oriented platform: **Admin / Owner dashboards, Touch POS, Card Tap Terminals,
Customer Display, Promotion (TV) Displays, Balance Kiosk and a 3-language Member Portal** — all on one
PostgreSQL database, synced in real time over WebSockets.

---

## Quick start (development)

Requirements: Node.js ≥ 20, PostgreSQL ≥ 14.

```bash
npm install
createdb arcade_dev                               # or set DATABASE_URL
cp .env.example server/.env                       # edit if needed
npm run seed     --workspace server               # DEV ONLY: demo branch, staff, members, machines, packages…
npm run build                                     # build the web app
npm start                                         # API + web on http://localhost:4000
# hot-reload development instead:  npm run dev  (API :4000, Vite :5173 with proxy)
```

The seed prints demo credentials (owner / manager / cashier usernames, passwords and PINs), member phones
(PIN `123456`) and ready-to-use terminal device tokens. **The seed refuses to run in production.**

| Surface | URL | Who |
|---|---|---|
| Admin / Owner / POS | `/` (`/login`) | Staff (username+password **or** employee code+PIN) |
| Card Tap Terminal | `/terminal` | Activated `ARCADE_TERMINAL` device at a machine |
| Customer Display | `/display` | Paired to a POS with a 6-digit code |
| Promotion Display (TV) | `/signage` | Any screen, choose a playlist |
| Check Balance kiosk | `/kiosk` | Activated `KIOSK` device |
| Member Portal | `/m` | Members (phone + 6-digit PIN), TH / EN / 中文 |
| Card QR landing | `/c/<token>` | From printed card QR (PIN required) |
| Digital receipt | `/r/<token>` | From receipt QR |

### First production start — Owner account
No password is ever hard-coded. Either set `OWNER_USERNAME`, `OWNER_PASSWORD` (≥10 chars) and `OWNER_PIN`
before the first boot (hashed with scrypt, created once), **or** leave them unset: the server prints a one-time
**setup token** to its console; open `/setup`, enter the token and create the owner. Then the **15-step Setup
Wizard** (business type → store → logo → theme → font → branch → payment → PromptPay → card → tiers → points →
M-Stamp → printer → customer display → ready) runs automatically.

### Tests
```bash
createdb arcade_test
npm test            # 29 tests: 10 business E2E scenarios + ledger / concurrency / RBAC / promotions / tiers / PromptPay
```

### Deployment
`docker compose up -d` (see `docker-compose.yml`; set `DB_PASSWORD`, `OWNER_*`, `PUBLIC_URL`). Migrations run
automatically at boot (advisory-locked, safe with several instances). Environments are separated by `NODE_ENV`
(`development` / `test` / `production`) and their own `DATABASE_URL`; use a staging database for staging.
Backups: `scripts/backup.sh` (pg_dump custom format + uploads tarball, restore instructions inside).
Run behind HTTPS (reverse proxy) with `TRUST_PROXY=1`; cookies are `Secure` in production.

---

## Architecture

```
web/  React 18 + Vite PWA ──HTTP /api──▶ server/  Express 5 ──▶ PostgreSQL (single source of truth)
        ▲  Socket.IO (rooms: staff, branch, card, member, machine, pair, displays) ◀── after-commit events
```

* `server/src/db/migrations/001_init.sql` — complete schema (52 tables incl. every table the spec lists;
  `wallets`, `wallet_transactions`, `point_transactions`, `stamp_transactions`, `machine_transactions`,
  `reward_inventory`, `users` are views over the unified ledger / stock tables).
* `server/src/services/` — domain logic (ledger, cards, members, orders/payments, tap, loyalty, tiers,
  promotions, rewards, shifts, receipts, reports). Routes are thin and validate with **zod**.
* `server/src/integrations/` — adapter layers: payment gateways, machine controller (allow-play), OTP, email,
  AI promotion copy. `web/src/lib/readers.js` and `web/src/lib/printer.js` — card-reader and printer layers.
* Public IDs are separate from UUIDs: `MBR000012`, 12-digit card numbers, `TXN202610100001`,
  `RCP202610100001`, `ORD…`, `PAY…`, `TOP…`, `RFD…`, `SFT…`.

## Financial integrity (the non-negotiables)

| Rule | How it is enforced |
|---|---|
| Balance never edited directly | DB trigger rejects any change to `cards.balance/points/stamps` unless the ledger service set a transaction-local flag; new cards must start at zero |
| Every change has a ledger row | `services/ledger.js#postEntry` updates the locked card **and** inserts an immutable `transactions` row (before / amount / bonus / after, points & stamps before/Δ/after, staff/device/machine/branch/order/payment refs) |
| Completed transactions never deleted | DB trigger forbids DELETE/UPDATE (only `reversed_by` may be set once). Refunds post a **reverse entry**; a partial unique index allows one reversal per transaction |
| No negative balance | `CHECK (balance >= 0)` on cards and on `balance_after` in the ledger |
| Atomic tap / payment | One DB transaction: lock card row (`SELECT … FOR UPDATE`) → validate → deduct → ledger → points/stamps → commit; any error rolls back everything. Realtime events & "allow play" fire only **after commit** |
| Concurrency | Row locks serialise all taps of a card across machines (tested: 6 simultaneous taps on ฿100 → exactly 2 approved) |
| Tap idempotency | `requestId` is reserved first in `tap_requests` (unique); replays return the stored result, concurrent duplicates wait and replay |
| Duplicate tap | Per-machine / global cooldown (default 3 s) checked under the card lock |
| No balance before payment | Top-ups are order items fulfilled only inside the transaction that marks the payment `PAID` |
| Webhook idempotency | `payment_events (provider, event_id)` unique + payment row lock; a second event for a paid payment is a no-op; amount mismatch is rejected; HMAC signature required |
| Traceability | Every amount traces Revenue → Order → Payment → Transaction → Staff/Device → Member → Card → Branch (`/transactions/:id` "Trace") |
| Reconciliation | Card page and Wallet-Liability report verify balance = Σ ledger deltas |
| Audit | `audit_logs` (immutable trigger) with actor, role, action, target, old/new data, device, IP, reason, approver |

## Module map (spec → implementation)

* **Staff, roles, permissions** — 11 default roles + custom roles; 74 permission codes across 25 modules (module.action);
  per-staff GRANT/DENY overrides; per-staff/role max discount; **manager approval** (employee code + PIN) for
  configurable actions (refund, adjust balance/points, remove stamps, void, merge…). Login by username+password
  or employee code+PIN, lock screen, switch staff, idle auto-lock, session idle timeout, lockout after failed
  logins, rate limiting.
* **Members** — registration with configurable/custom fields, duplicate phone check, PIN 6 digits (scrypt),
  tiers (unlimited, auto-upgrade, manual override lock), merge duplicates, suspend/block/delete, timeline.
* **Cards** — 12-digit unique numbers (Luhn-checked when generated), auto-generate / manual / CSV import,
  batches 100/500/1000 with CSV export & label printing, member & guest cards, deposit & refund on return,
  replacement transferring balance/points/stamps/deposit, block/lost/unblock, expiry policies (keep/forfeit),
  RFID/NFC UID linking, secure rotating QR token, A4 card-details print.
* **Identification** — typed number, barcode, QR (camera via BarcodeDetector/jsQR), RFID/NFC reader.
* **POS** — touch-first cart (top-ups, packages, card issue/deposit, replacement, food/merch), member + card
  verification workflow (card must belong to the identified member), promotions, tier discount, VAT
  off/inclusive/exclusive, service charge, discounts with limits, Quick Cash, PromptPay dynamic QR, bank
  transfer, EDC card/e-wallet (approval code only — no card data stored), gateway, pay by card balance,
  shifts (opening cash, cash in/out, expected vs actual, over/short), receipts, reprint log, refunds with
  refund receipts, void.
* **Card Tap Terminal** — 14-step tap workflow, success / insufficient-balance (with top-up QR) / error
  screens in TH/EN/中文, sounds, offline detection (refuses taps), heartbeat, device activation by code.
* **Machines** — fixed / member / tier / happy-hour / free-play pricing, points & stamps per play, credits,
  status (AVAILABLE/MAINTENANCE/DISABLED/ERROR) + live ONLINE/OFFLINE.
* **Loyalty** — points (amount→points, tier & promotion multipliers, expiry), M-Stamp (rules per play/food/
  top-up, tier multiplier, max, expiry, stamp→point conversion AUTO/MEMBER/STAFF).
* **Promotions** — rule engine (member only, tier, min amount, plays today, days, time window, birthday month,
  branch, machine, category, merchant, package) × effects (bonus ฿/%, discount ฿/%, fixed price, free play,
  point/stamp bonus & multipliers), priority / best / stack policies, usage limits. Top-up packages.
* **Rewards** — catalog with stock, tier/member/branch/date limits; member redeems in portal → QR code →
  counter confirms (deducts points/stamps/stock once; reuse blocked); counter redemption; cancellation with
  reversal; stock movements & low-stock alerts.
* **Customer Display** — 6-digit pairing, language selection first (TH/EN/中文), privacy consent (versioned
  policies, stored per device/member), member prompt, phone keypad, card tap on display, split layout with
  promotion playlist, PromptPay QR with countdown, success screen, session timeout.
* **Promotion Displays** — playlists of images/videos/text slides, duration, schedule (dates, weekdays,
  time window, priority), approval-gated media, live updates; **AI Promotion Generator** (Claude-written
  copy when `ANTHROPIC_API_KEY` is set, otherwise template copy) renders TV 16:9, display 9:16, social 1:1 and
  animated motion banners → preview → approval → publish to playlist.
* **Reports** — sales, top-up, card balance, wallet liability (member/guest/expired/blocked), member, tier,
  point, stamp, redemption, arcade, machine, payment, promotion, staff, refund, adjustment, merchant
  settlement, shift, ledger; filters (today/yesterday/week/month/custom, branch, staff, machine, tier, payment,
  type); export CSV / Excel / Print-to-PDF.
* **Dashboards** — live KPIs & charts from the ledger; Owner dashboard across branches with wallet & reward
  liability and open shifts.
* **Multi-branch** — branch records with per-branch settings overrides; staff, devices, machines, receipts
  (receipt numbers scoped per branch) and reports per branch.
* **Food Park** — merchants with products, merchant-scoped staff, card-balance payment, merchant report
  (gross, refunds, net, commission, settlement).
* **Settings** — 27 sections (General … Integration), theme colours / radius / button style / dark mode,
  logo / favicon / login background, fonts per surface (any Google Font or uploaded .ttf/.otf/.woff/.woff2).
* **i18n** — customer surfaces (Display, Portal, Terminal, Kiosk) use translation keys only (`web/src/lib/i18n.jsx`).

## Hardware & provider integration — what is real vs. adapter

Nothing pretends to be connected: statuses only change after a real browser/device API succeeds.

| Area | Works out of the box | Adapter / configuration needed for |
|---|---|---|
| Card readers | Keyboard-emulation USB/RFID/barcode readers; Web NFC (Android Chrome); Web Serial; WebHID; BLE UART readers; camera QR | Proprietary SDK readers → implement a reader class in `web/src/lib/readers.js` |
| Printers | Browser printing (58/80 mm, A4, labels); ESC/POS over WebUSB, Web Bluetooth, Web Serial; LAN 9100 via `bridge/print-bridge.mjs` (+ subnet scan); cash drawer kick | — |
| Machine "Allow Play" | Socket event `play:allow` to the terminal; optional HTTP relay URL per device | Physical relay/coin board firmware |
| Payments | Cash, PromptPay EMVCo QR (static/dynamic, CRC-verified) with staff confirmation, bank transfer, EDC approval codes, card balance | Payment gateway: implement `createPayment / parseWebhook / refund` in `server/src/integrations/payment/` (a signed **mock** gateway with "TEST MODE" simulate button is included and is blocked in production) |
| OTP (forgot PIN) | Dev console provider | SMS provider adapter (`integrations/otp`); otherwise staff resets PINs |
| Email receipts | Dev console | `EMAIL_PROVIDER=webhook` to your mail relay |
| Offline terminals | Detect offline and refuse taps (safe default) | An offline queue is intentionally **not** enabled |

## Security notes
scrypt password/PIN hashing · opaque random session tokens stored hashed · httpOnly SameSite cookies + required
`X-Requested-With` header (CSRF) · Helmet CSP · rate limits on login/activation/portal · zod validation on every
input · parameterised SQL only · React escaping (no `dangerouslySetInnerHTML`) · secrets redacted from logs ·
QR codes carry random tokens only (revocable), card QR still requires the member PIN · devices authenticate with
their own revocable tokens · no raw card numbers / CVV ever collected.

## Project layout
```
server/src   config, app, socket, jobs, bootstrap, db (pool, migrate, seed, migrations), lib, middleware,
             services, routes, integrations
server/test  helpers + e2e.test.js (10 scenarios) + core.test.js (invariants)
web/src      lib (api, auth, i18n, realtime, readers, printer, theme, sound, pairing), components, pages
             (admin, device, member)
bridge/      Local Print Bridge for LAN printers
scripts/     backup.sh
```
