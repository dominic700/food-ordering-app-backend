-- ============================================================
--  FOOD ORDERING PLATFORM — DATABASE SCHEMA
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── 1. ADMINS ────────────────────────────────────────────────
-- Manually seeded. Only you and your team.
CREATE TABLE admins (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id   BIGINT UNIQUE,
    name          VARCHAR(100),
    email         VARCHAR(100) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMP DEFAULT NOW()
);

-- ── 2. CAFES ─────────────────────────────────────────────────
CREATE TABLE cafes (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name               VARCHAR(100) NOT NULL,
    description        TEXT,
    logo_url           TEXT,
    address            TEXT,
    phone              VARCHAR(20),
    service_fee        NUMERIC(10,2) NOT NULL DEFAULT 0,
    is_active          BOOLEAN DEFAULT TRUE,
    cbe_account_name   VARCHAR(100),
    cbe_account_number VARCHAR(50),
    telebirr_name      VARCHAR(100),
    telebirr_phone     VARCHAR(20),
    created_at         TIMESTAMP DEFAULT NOW()
);

-- ── 3. CAFE OWNERS ───────────────────────────────────────────
-- Created by admin. Linked to a cafe via telegram_id.
CREATE TABLE cafe_owners (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cafe_id     UUID NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    telegram_id BIGINT UNIQUE NOT NULL,
    name        VARCHAR(100),
    phone       VARCHAR(20),
    language    VARCHAR(2) NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'am')),
    created_at  TIMESTAMP DEFAULT NOW()
);

-- ── 4. GLOBAL ACCOUNTS ───────────────────────────────────────
-- Auto-created when customer opens the app for the first time.
CREATE TABLE global_accounts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id BIGINT UNIQUE NOT NULL,
    name        VARCHAR(100),
    phone       VARCHAR(20) NOT NULL,
    language    VARCHAR(2) NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'am')),
    created_at  TIMESTAMP DEFAULT NOW()
);

-- ── 5. PER-CAFE ACCOUNTS ─────────────────────────────────────
-- Created when customer registers at a specific cafe.
--
-- balance: a single SIGNED running total.
--   positive -> customer has deposited money available to spend
--   negative -> customer is using credit (they owe this much)
-- credit_limit: how far NEGATIVE the balance is allowed to go,
--   set directly by the cafe owner from the customer's profile
--   at any time (no application/approval flow, no deposit
--   threshold required). e.g. credit_limit = 500 means balance
--   can drop as low as -500.
CREATE TABLE per_cafe_accounts (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    global_account_id UUID NOT NULL REFERENCES global_accounts(id) ON DELETE CASCADE,
    cafe_id           UUID NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    balance           NUMERIC(10,2) NOT NULL DEFAULT 0,
    credit_limit      NUMERIC(10,2) NOT NULL DEFAULT 0,
    status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','suspended')),
    registered_at     TIMESTAMP DEFAULT NOW(),
    approved_at       TIMESTAMP,
    UNIQUE (global_account_id, cafe_id)
);

-- ── 6. MENU CATEGORIES ───────────────────────────────────────
CREATE TABLE menu_categories (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cafe_id       UUID NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    name          VARCHAR(100) NOT NULL,
    display_order INT DEFAULT 0,
    created_at    TIMESTAMP DEFAULT NOW(),
    UNIQUE (cafe_id, name)
);

-- ── 7. MENU ITEMS ────────────────────────────────────────────
-- `price` is the BASE price set by the cafe owner (what the cafe keeps).
-- The cafe's service_fee is added on top of this price for every unit
-- shown to / charged from the customer (computed at read/order time,
-- not stored here, so changing a cafe's fee updates all items instantly).
--
-- `discount_percent` is set by the CAFE OWNER per item, when creating
-- or editing their menu. It applies ONLY when the order is paid via
-- 'wallet' (balance AND/OR credit combined) — NOT to 'transfer' orders.
--   list_price   = price (base) + cafe.service_fee
--   wallet_price = list_price * (1 - discount_percent/100)
CREATE TABLE menu_items (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cafe_id          UUID NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    category_id      UUID REFERENCES menu_categories(id) ON DELETE SET NULL,
    name             VARCHAR(100) NOT NULL,
    description      TEXT,
    price            NUMERIC(10,2) NOT NULL,
    discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0
                     CHECK (discount_percent >= 0 AND discount_percent <= 100),
    image_url        TEXT,
    is_available     BOOLEAN DEFAULT TRUE,
    created_at       TIMESTAMP DEFAULT NOW()
);

-- ── 8. ORDERS ────────────────────────────────────────────────
-- subtotal        = sum of base item prices x quantity   (cafe's portion, list)
-- service_fee     = sum of (cafe.service_fee x quantity) (platform fee, list)
-- discount_amount = sum of per-item discounts (each item's
--                    discount_percent applied to its list unit price x qty).
--                    Only non-zero for payment_method = 'wallet'.
-- total           = subtotal + service_fee - discount_amount
--                    (this is the amount actually paid / deducted)
--
-- payment_method:
--   'wallet'   -> deducted from per_cafe_accounts.balance, a single
--                 SIGNED number (can go negative, down to -credit_limit).
--                 paid_from_balance/paid_from_credit below are kept only
--                 as a record of how much of this order's total came from
--                 an already-positive balance vs. pushed the account
--                 negative (into credit) — for reporting purposes.
--                 Per-item discounts apply. Requires an approved
--                 per_cafe_account.
--   'transfer' -> paid externally via Telebirr/CBE/Bank, balance is NOT
--                 touched, no discount. Only needs a global_account
--                 (no cafe registration required).
--   'cash'     -> paid in person to the cafe, balance is NOT touched,
--                 no discount. Only needs a global_account (no cafe
--                 registration required).
CREATE TABLE orders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cafe_id             UUID NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    per_cafe_account_id UUID NOT NULL REFERENCES per_cafe_accounts(id) ON DELETE CASCADE,
    subtotal            NUMERIC(10,2) NOT NULL,
    service_fee         NUMERIC(10,2) NOT NULL DEFAULT 0,
    total               NUMERIC(10,2) NOT NULL,
    discount_amount     NUMERIC(10,2) NOT NULL DEFAULT 0,
    paid_from_balance   NUMERIC(10,2) NOT NULL DEFAULT 0,
    paid_from_credit    NUMERIC(10,2) NOT NULL DEFAULT 0,
    payment_method      VARCHAR(20) NOT NULL DEFAULT 'wallet'
                        CHECK (payment_method IN ('wallet','transfer','cash')),
    transfer_provider   VARCHAR(30)
                        CHECK (transfer_provider IN ('telebirr','cbe_birr','bank_transfer')),
    transaction_number  VARCHAR(100),
    status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','cancelled')),
    note                TEXT,
    created_at          TIMESTAMP DEFAULT NOW(),
    approved_at         TIMESTAMP,
    cancelled_at        TIMESTAMP
);

-- ── 9. ORDER ITEMS ───────────────────────────────────────────
CREATE TABLE order_items (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id     UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    name         VARCHAR(100) NOT NULL,
    price        NUMERIC(10,2) NOT NULL,
    quantity     INT NOT NULL CHECK (quantity > 0),
    item_total   NUMERIC(10,2) NOT NULL
);

-- ── 10. DEPOSITS ─────────────────────────────────────────────
CREATE TABLE deposits (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    per_cafe_account_id UUID NOT NULL REFERENCES per_cafe_accounts(id) ON DELETE CASCADE,
    cafe_id             UUID NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    amount              NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    payment_method      VARCHAR(30) NOT NULL
                        CHECK (payment_method IN ('telebirr','cbe_birr','bank_transfer','cash')),
    transaction_number  VARCHAR(100) NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','verified','failed')),
    created_at          TIMESTAMP DEFAULT NOW(),
    verified_at         TIMESTAMP
);

-- ── 11. PROMOTIONS ───────────────────────────────────────────
-- Promo slider images shown on customer home screen
CREATE TABLE promotions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cafe_id    UUID REFERENCES cafes(id) ON DELETE CASCADE,
    image_url  TEXT NOT NULL,
    title      VARCHAR(100),
    is_active  BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ── 12. NOTIFICATIONS ────────────────────────────────────────
-- In-app notification history, separate from the Telegram bot
-- messages. Powers the bell icon in all three portals (customer,
-- cafe owner, admin). Identified by telegram_id so any role can
-- query "my notifications" with one simple lookup.
--
-- type examples: 'new_order', 'order_approved', 'registration_request',
--   'registration_approved', 'credit_limit_set', 'deposit_verified',
--   'promo_added', 'cafe_created'
CREATE TABLE notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id BIGINT NOT NULL,
    cafe_id     UUID REFERENCES cafes(id) ON DELETE CASCADE,
    type        VARCHAR(40) NOT NULL,
    title       VARCHAR(150) NOT NULL,
    body        TEXT,
    is_read     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMP DEFAULT NOW()
);

-- ── 13. REVENUE SNAPSHOTS ───────────────────────────────────
-- Saved when the cafe owner resets their 30-day income counter.
-- Stores the last 6 months of reset history per cafe.
CREATE TABLE revenue_snapshots (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cafe_id      UUID NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    period_start TIMESTAMP NOT NULL,
    period_end   TIMESTAMP NOT NULL DEFAULT NOW(),
    revenue_30d       NUMERIC(10,2) NOT NULL DEFAULT 0,
    wallet_revenue    NUMERIC(10,2) NOT NULL DEFAULT 0,
    instant_revenue   NUMERIC(10,2) NOT NULL DEFAULT 0,
    deposits_30d      NUMERIC(10,2) NOT NULL DEFAULT 0,
    orders_count      INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMP DEFAULT NOW()
);

-- ── INDEXES ──────────────────────────────────────────────────
CREATE INDEX idx_cafes_active          ON cafes(is_active);
CREATE INDEX idx_cafe_owners_telegram  ON cafe_owners(telegram_id);
CREATE INDEX idx_global_accounts_tg    ON global_accounts(telegram_id);
CREATE INDEX idx_pca_global            ON per_cafe_accounts(global_account_id);
CREATE INDEX idx_pca_cafe              ON per_cafe_accounts(cafe_id);
CREATE INDEX idx_pca_status            ON per_cafe_accounts(status);
CREATE INDEX idx_menu_items_cafe       ON menu_items(cafe_id);
CREATE INDEX idx_menu_categories_cafe  ON menu_categories(cafe_id);
CREATE INDEX idx_orders_cafe           ON orders(cafe_id);
CREATE INDEX idx_orders_pca            ON orders(per_cafe_account_id);
CREATE INDEX idx_orders_status         ON orders(status);
CREATE INDEX idx_orders_created        ON orders(created_at);
CREATE INDEX idx_order_items_order     ON order_items(order_id);
CREATE INDEX idx_deposits_pca          ON deposits(per_cafe_account_id);
CREATE INDEX idx_deposits_status       ON deposits(status);
CREATE INDEX idx_notifications_tg      ON notifications(telegram_id);
CREATE INDEX idx_notifications_read    ON notifications(telegram_id, is_read);
CREATE INDEX idx_revenue_snapshots_cafe ON revenue_snapshots(cafe_id, created_at DESC);

-- ── SEED ADMIN ───────────────────────────────────────────────
-- Default admin account — change password after first login
-- Password is: admin123
INSERT INTO admins (name, email, password_hash)
VALUES (
  'Super Admin',
  'admin@foodapp.com',
  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi'
);
