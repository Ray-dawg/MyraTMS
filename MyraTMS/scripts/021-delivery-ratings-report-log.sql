CREATE TABLE IF NOT EXISTS delivery_ratings (
  id TEXT PRIMARY KEY,
  load_id TEXT NOT NULL,
  shipper_id TEXT NOT NULL,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT DEFAULT '',
  token_hash TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_delivery_ratings_load ON delivery_ratings(load_id);

CREATE TABLE IF NOT EXISTS shipper_report_log (
  id TEXT PRIMARY KEY,
  shipper_id TEXT NOT NULL,
  period_year SMALLINT NOT NULL,
  period_month SMALLINT NOT NULL,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  email_to TEXT NOT NULL,
  loads_count INT DEFAULT 0,
  UNIQUE (shipper_id, period_year, period_month)
);
CREATE INDEX IF NOT EXISTS idx_shipper_report_log ON shipper_report_log(shipper_id, period_year, period_month);
