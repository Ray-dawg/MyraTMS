-- M1 Build Migration
-- Adds tracking, driver, event, workflow, and settings tables
-- ============================================================

-- Enable uuid-ossp if not already available (gen_random_uuid is built-in to PG 13+)
-- CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 1. DRIVERS
-- ============================================================
CREATE TABLE IF NOT EXISTS drivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier_id TEXT REFERENCES carriers(id) ON DELETE SET NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  app_pin VARCHAR(6),
  status TEXT DEFAULT 'available' CHECK (status IN ('available', 'on_load', 'offline')),
  last_known_lat DECIMAL(10,7),
  last_known_lng DECIMAL(10,7),
  last_ping_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_drivers_carrier ON drivers(carrier_id);
CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(status);

-- ============================================================
-- 2. LOCATION PINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS location_pings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id TEXT REFERENCES loads(id) ON DELETE CASCADE,
  driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
  lat DECIMAL(10,7) NOT NULL,
  lng DECIMAL(10,7) NOT NULL,
  speed_mph DECIMAL(5,1),
  heading DECIMAL(5,1),
  recorded_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_location_pings_load_time ON location_pings(load_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_location_pings_driver ON location_pings(driver_id);

-- ============================================================
-- 3. LOAD EVENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS load_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id TEXT REFERENCES loads(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  status VARCHAR(50),
  location VARCHAR(200),
  note TEXT,
  created_by VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_load_events_load_time ON load_events(load_id, created_at);

-- ============================================================
-- 4. CHECK CALLS
-- ============================================================
CREATE TABLE IF NOT EXISTS check_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id TEXT REFERENCES loads(id) ON DELETE CASCADE,
  driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
  location VARCHAR(200),
  status VARCHAR(50),
  notes TEXT,
  next_check_call TIMESTAMPTZ,
  created_by VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_check_calls_load ON check_calls(load_id);
CREATE INDEX IF NOT EXISTS idx_check_calls_next ON check_calls(next_check_call);

-- ============================================================
-- 5. TRACKING TOKENS
-- ============================================================
CREATE TABLE IF NOT EXISTS tracking_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id TEXT UNIQUE REFERENCES loads(id) ON DELETE CASCADE,
  token VARCHAR(64) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tracking_tokens_token ON tracking_tokens(token);

-- ============================================================
-- 6. SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  settings_key VARCHAR(100) NOT NULL,
  settings_value JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Unique constraint: one value per key per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_user_key ON settings(user_id, settings_key);

-- ============================================================
-- 7. WORKFLOWS
-- ============================================================
CREATE TABLE IF NOT EXISTS workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  trigger_type VARCHAR(50),
  trigger_config JSONB DEFAULT '{}',
  conditions JSONB DEFAULT '[]',
  actions JSONB DEFAULT '[]',
  active BOOLEAN DEFAULT true,
  created_by VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- 8. ALTER LOADS TABLE — Add tracking & geo columns
-- ============================================================
ALTER TABLE loads ADD COLUMN IF NOT EXISTS driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS tracking_token VARCHAR(64) UNIQUE;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS current_lat DECIMAL(10,7);
ALTER TABLE loads ADD COLUMN IF NOT EXISTS current_lng DECIMAL(10,7);
ALTER TABLE loads ADD COLUMN IF NOT EXISTS current_eta TIMESTAMPTZ;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS origin_lat DECIMAL(10,7);
ALTER TABLE loads ADD COLUMN IF NOT EXISTS origin_lng DECIMAL(10,7);
ALTER TABLE loads ADD COLUMN IF NOT EXISTS dest_lat DECIMAL(10,7);
ALTER TABLE loads ADD COLUMN IF NOT EXISTS dest_lng DECIMAL(10,7);
ALTER TABLE loads ADD COLUMN IF NOT EXISTS pod_url TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS commodity VARCHAR(200);
ALTER TABLE loads ADD COLUMN IF NOT EXISTS po_number VARCHAR(100);
ALTER TABLE loads ADD COLUMN IF NOT EXISTS reference_number VARCHAR(50) UNIQUE;

CREATE INDEX IF NOT EXISTS idx_loads_driver ON loads(driver_id);
CREATE INDEX IF NOT EXISTS idx_loads_tracking_token ON loads(tracking_token);
