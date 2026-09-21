CREATE TABLE IF NOT EXISTS revenue_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cafe_id         UUID NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    period_start    TIMESTAMP NOT NULL,
    period_end      TIMESTAMP NOT NULL DEFAULT NOW(),
    revenue_30d     NUMERIC(10,2) NOT NULL DEFAULT 0,
    wallet_revenue  NUMERIC(10,2) NOT NULL DEFAULT 0,
    instant_revenue NUMERIC(10,2) NOT NULL DEFAULT 0,
    deposits_30d    NUMERIC(10,2) NOT NULL DEFAULT 0,
    orders_count    INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_revenue_snapshots_cafe ON revenue_snapshots(cafe_id, created_at DESC);