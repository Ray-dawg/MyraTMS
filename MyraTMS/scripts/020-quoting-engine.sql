-- ============================================================
-- 020-quoting-engine.sql
-- Quoting engine: quotes, rate_cache, integrations, distance_cache, fuel_index, quote_corrections
-- ============================================================

-- Full quote records with audit trail
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  reference VARCHAR(50) UNIQUE NOT NULL,
  shipper_id TEXT REFERENCES shippers(id),
  shipper_name VARCHAR(255),
  origin_address TEXT NOT NULL,
  origin_lat DECIMAL(10,6),
  origin_lng DECIMAL(10,6),
  origin_region VARCHAR(100),
  dest_address TEXT NOT NULL,
  dest_lat DECIMAL(10,6),
  dest_lng DECIMAL(10,6),
  dest_region VARCHAR(100),
  equipment_type VARCHAR(50) NOT NULL,
  weight_lbs INTEGER DEFAULT 42000,
  commodity VARCHAR(255),
  pickup_date DATE,
  distance_miles DECIMAL(10,2),
  distance_km DECIMAL(10,2),
  drive_time_hours DECIMAL(6,2),
  rate_per_mile DECIMAL(8,4),
  carrier_cost_estimate DECIMAL(10,2),
  fuel_surcharge DECIMAL(10,2) DEFAULT 0,
  shipper_rate DECIMAL(10,2),
  margin_percent DECIMAL(6,4),
  margin_dollars DECIMAL(10,2),
  rate_source VARCHAR(50),
  rate_source_detail JSONB DEFAULT '{}',
  confidence DECIMAL(4,3),
  confidence_label VARCHAR(10),
  rate_range_low DECIMAL(10,2),
  rate_range_high DECIMAL(10,2),
  status VARCHAR(20) DEFAULT 'draft',
  valid_until TIMESTAMP,
  actual_carrier_cost DECIMAL(10,2),
  quote_accuracy DECIMAL(4,3),
  load_id TEXT REFERENCES loads(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_quotes_shipper ON quotes(shipper_id);
CREATE INDEX IF NOT EXISTS idx_quotes_created ON quotes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_load ON quotes(load_id);
CREATE INDEX IF NOT EXISTS idx_quotes_reference ON quotes(reference);

-- Cached lane rates from all sources
CREATE TABLE IF NOT EXISTS rate_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  origin_region VARCHAR(100) NOT NULL,
  dest_region VARCHAR(100) NOT NULL,
  equipment_type VARCHAR(50) NOT NULL,
  rate_per_mile DECIMAL(8,4),
  total_rate DECIMAL(10,2),
  source VARCHAR(50) NOT NULL,
  source_detail JSONB DEFAULT '{}',
  fetched_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rate_cache_lane ON rate_cache(origin_region, dest_region, equipment_type);
CREATE INDEX IF NOT EXISTS idx_rate_cache_source ON rate_cache(source);
CREATE INDEX IF NOT EXISTS idx_rate_cache_expires ON rate_cache(expires_at);

-- API key storage for external integrations
CREATE TABLE IF NOT EXISTS integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider VARCHAR(50) UNIQUE NOT NULL,
  api_key TEXT,
  api_secret TEXT,
  config JSONB DEFAULT '{}',
  enabled BOOLEAN DEFAULT false,
  last_success_at TIMESTAMP,
  last_error_at TIMESTAMP,
  last_error_msg TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Distance cache for geocoded routes
CREATE TABLE IF NOT EXISTS distance_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  origin_hash VARCHAR(64) NOT NULL,
  dest_hash VARCHAR(64) NOT NULL,
  origin_address TEXT,
  dest_address TEXT,
  distance_km DECIMAL(10,2),
  distance_miles DECIMAL(10,2),
  drive_time_hours DECIMAL(6,2),
  origin_lat DECIMAL(10,6),
  origin_lng DECIMAL(10,6),
  dest_lat DECIMAL(10,6),
  dest_lng DECIMAL(10,6),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_distance_cache_hashes ON distance_cache(origin_hash, dest_hash);

-- Fuel price index
CREATE TABLE IF NOT EXISTS fuel_index (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source VARCHAR(50) NOT NULL,
  price_per_litre DECIMAL(6,4) NOT NULL,
  region VARCHAR(100),
  effective_date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fuel_index_date ON fuel_index(effective_date DESC);

-- Per-source per-lane correction factors for feedback loop
CREATE TABLE IF NOT EXISTS quote_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source VARCHAR(50) NOT NULL,
  origin_region VARCHAR(100) NOT NULL,
  dest_region VARCHAR(100) NOT NULL,
  equipment_type VARCHAR(50) NOT NULL,
  correction_factor DECIMAL(6,4) DEFAULT 1.0000,
  sample_size INTEGER DEFAULT 0,
  last_updated TIMESTAMP DEFAULT NOW(),
  UNIQUE(source, origin_region, dest_region, equipment_type)
);

-- Add quote_id FK to loads table
ALTER TABLE loads ADD COLUMN IF NOT EXISTS quote_id TEXT REFERENCES quotes(id);

-- Seed fuel index with current Canadian diesel
INSERT INTO fuel_index (id, source, price_per_litre, region, effective_date)
VALUES (gen_random_uuid(), 'manual', 1.6400, 'Ontario', '2026-03-01');
