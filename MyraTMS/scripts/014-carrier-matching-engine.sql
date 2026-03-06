-- ============================================================
-- 014: Carrier Matching Engine — Schema Additions
-- ============================================================

-- 1. carrier_equipment — tracks equipment types each carrier owns
CREATE TABLE IF NOT EXISTS carrier_equipment (
  id              TEXT PRIMARY KEY DEFAULT 'CE-' || UPPER(TO_HEX(EXTRACT(EPOCH FROM NOW())::BIGINT)),
  carrier_id      TEXT NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
  equipment_type  VARCHAR(30) NOT NULL CHECK (equipment_type IN ('Dry Van','Reefer','Flatbed','Step Deck')),
  truck_count     INTEGER DEFAULT 1,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_carrier_equip_type
  ON carrier_equipment (equipment_type, carrier_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_carrier_equip_unique
  ON carrier_equipment (carrier_id, equipment_type);


-- 2. carrier_lanes — precomputed lane history cache
CREATE TABLE IF NOT EXISTS carrier_lanes (
  id              TEXT PRIMARY KEY DEFAULT 'CL-' || UPPER(TO_HEX(EXTRACT(EPOCH FROM NOW())::BIGINT)),
  carrier_id      TEXT NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
  origin_region   VARCHAR(100) NOT NULL,
  dest_region     VARCHAR(100) NOT NULL,
  equipment_type  VARCHAR(30),
  load_count      INTEGER DEFAULT 0,
  avg_carrier_rate DECIMAL(10,2),
  last_load_date  DATE,
  on_time_rate    DECIMAL(3,2),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_carrier_lane_unique
  ON carrier_lanes (carrier_id, origin_region, dest_region, equipment_type);

CREATE INDEX IF NOT EXISTS idx_carrier_lane_region
  ON carrier_lanes (origin_region, dest_region);


-- 3. match_results — audit and learning table
CREATE TABLE IF NOT EXISTS match_results (
  id              TEXT PRIMARY KEY DEFAULT 'MR-' || UPPER(TO_HEX(EXTRACT(EPOCH FROM NOW())::BIGINT)),
  load_id         TEXT REFERENCES loads(id) ON DELETE SET NULL,
  carrier_id      TEXT REFERENCES carriers(id) ON DELETE SET NULL,
  match_score     DECIMAL(4,3),
  match_grade     VARCHAR(1) CHECK (match_grade IN ('A','B','C','D','F')),
  breakdown       JSONB,
  was_selected    BOOLEAN DEFAULT FALSE,
  was_accepted    BOOLEAN,
  assignment_method VARCHAR(20) DEFAULT 'matched',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_match_load ON match_results (load_id);
CREATE INDEX IF NOT EXISTS idx_match_carrier ON match_results (carrier_id);
CREATE INDEX IF NOT EXISTS idx_match_created ON match_results (created_at);


-- 4. Add columns to carriers table
ALTER TABLE carriers ADD COLUMN IF NOT EXISTS home_lat DECIMAL(10,7);
ALTER TABLE carriers ADD COLUMN IF NOT EXISTS home_lng DECIMAL(10,7);
ALTER TABLE carriers ADD COLUMN IF NOT EXISTS home_city VARCHAR(100);
ALTER TABLE carriers ADD COLUMN IF NOT EXISTS communication_rating DECIMAL(3,2) DEFAULT 3.0;
ALTER TABLE carriers ADD COLUMN IF NOT EXISTS overall_match_score DECIMAL(4,3);


-- 5. Seed carrier_equipment from existing carriers (parse from equipment field or default)
-- This populates equipment data for carriers that have loads with equipment info
INSERT INTO carrier_equipment (id, carrier_id, equipment_type, truck_count)
SELECT DISTINCT
  'CE-' || UPPER(SUBSTRING(MD5(c.id || l.equipment) FROM 1 FOR 12)),
  c.id,
  CASE
    WHEN l.equipment ILIKE '%reefer%' THEN 'Reefer'
    WHEN l.equipment ILIKE '%flat%' THEN 'Flatbed'
    WHEN l.equipment ILIKE '%step%' THEN 'Step Deck'
    ELSE 'Dry Van'
  END,
  1
FROM carriers c
JOIN loads l ON l.carrier_id = c.id
WHERE l.equipment IS NOT NULL AND l.equipment != ''
ON CONFLICT (carrier_id, equipment_type) DO NOTHING;


-- 6. Seed carrier home locations from their most frequent origin
-- Uses the most common origin city from their load history
UPDATE carriers SET
  home_city = sub.city,
  home_lat = sub.lat,
  home_lng = sub.lng
FROM (
  SELECT DISTINCT ON (l.carrier_id)
    l.carrier_id,
    l.origin as city,
    l.origin_lat as lat,
    l.origin_lng as lng
  FROM loads l
  WHERE l.carrier_id IS NOT NULL
    AND l.origin_lat IS NOT NULL
  ORDER BY l.carrier_id, l.created_at DESC
) sub
WHERE carriers.id = sub.carrier_id
  AND carriers.home_lat IS NULL;
