-- ============================================================
--  COMBINED MIGRATIONS 001–005
-- ============================================================
-- Runs all five migrations in order, in one file. Every step uses
-- IF EXISTS / IF NOT EXISTS guards, so this is safe to run on:
--   - a fresh DB that only ran schema.sql
--   - a DB that already has some (but not all) of these applied
--   - a DB that already has all five applied (it's a no-op)
--
-- Usage:
--   psql "your_database_url" -f db/migrations_combined.sql
--
-- (The individual migration_00N_*.sql files are kept as-is for
-- reference / history — this file just runs the same statements
-- back to back so you don't have to run five separate commands.)


-- ── MIGRATION 001 — notifications table ─────────────────────
-- Adds the notifications table. Already part of schema.sql for
-- fresh installs, but kept here (with IF NOT EXISTS) for DBs that
-- were set up before it was added.

CREATE TABLE IF NOT EXISTS notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id BIGINT NOT NULL,
    cafe_id     UUID REFERENCES cafes(id) ON DELETE CASCADE,
    type        VARCHAR(40) NOT NULL,
    title       VARCHAR(150) NOT NULL,
    body        TEXT,
    is_read     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_tg   ON notifications(telegram_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(telegram_id, is_read);


-- ── MIGRATION 002 — allow 'cash' as a payment method ────────
-- Fixes the orders.payment_method CHECK constraint, which was
-- created before 'cash' existed as a payment option.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;

ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check
  CHECK (payment_method IN ('wallet', 'transfer', 'cash'));


-- ── MIGRATION 003 — signed balance (drop credit_used / credit_applications)
-- Simplifies the credit model: per_cafe_accounts.balance becomes a
-- single SIGNED number (positive = deposited funds, negative =
-- customer owes money via credit). Folds any existing credit_used
-- back into balance before dropping it, so no money is lost:
--   new_balance = old_balance - old_credit_used

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'per_cafe_accounts' AND column_name = 'credit_used'
  ) THEN
    UPDATE per_cafe_accounts
    SET balance = balance - credit_used
    WHERE credit_used > 0;

    ALTER TABLE per_cafe_accounts DROP COLUMN credit_used;
  END IF;
END $$;

DROP TABLE IF EXISTS credit_applications;

COMMIT;


-- ── MIGRATION 004 — fee_collections table ───────────────────
-- Tracks weekly item counts and service fees collected per cafe.
-- Each row is one "week" that the admin manually closed by
-- pressing the Restart button.

CREATE TABLE IF NOT EXISTS fee_collections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cafe_id         UUID NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    -- The week being closed
    period_start    TIMESTAMP NOT NULL,  -- when last Restart was pressed (or cafe creation)
    period_end      TIMESTAMP NOT NULL DEFAULT NOW(),
    -- Totals for that period
    total_items     INT NOT NULL DEFAULT 0,   -- sum of all item quantities
    total_fee       NUMERIC(10,2) NOT NULL DEFAULT 0, -- sum of service_fee across approved orders
    -- Who pressed restart and when
    collected_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    collected_by    VARCHAR(100)  -- admin name or telegram_id
);

CREATE INDEX IF NOT EXISTS idx_fee_collections_cafe
    ON fee_collections(cafe_id);

CREATE INDEX IF NOT EXISTS idx_fee_collections_date
    ON fee_collections(cafe_id, collected_at DESC);


-- ── MIGRATION 005 — fee_collections.total_revenue ───────────
-- Adds total_revenue tracking alongside total_items/total_fee, so
-- both the admin dashboard and the cafe owner's profile page can
-- show order revenue for the same reset-able collection period.

ALTER TABLE fee_collections
  ADD COLUMN IF NOT EXISTS total_revenue NUMERIC(10,2) NOT NULL DEFAULT 0;


-- ── MIGRATION 006 — language preference ─────────────────────
-- Stores each customer's and cafe owner's chosen app language, so
-- server-sent Telegram bot notifications match the language they
-- picked in the app (not just the in-app UI text).

ALTER TABLE global_accounts
  ADD COLUMN IF NOT EXISTS language VARCHAR(2) NOT NULL DEFAULT 'en'
  CHECK (language IN ('en', 'am'));

ALTER TABLE cafe_owners
  ADD COLUMN IF NOT EXISTS language VARCHAR(2) NOT NULL DEFAULT 'en'
  CHECK (language IN ('en', 'am'));
