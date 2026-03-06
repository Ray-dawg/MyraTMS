-- M1 Build - Seed Test Drivers
-- Links to carriers from 003-seed-data-fixed.sql
-- ============================================================

INSERT INTO drivers (id, carrier_id, first_name, last_name, phone, email, app_pin, status, last_known_lat, last_known_lng, last_ping_at)
VALUES
  -- FastHaul Logistics driver (car_001) — currently on LD-2024-001 (CHI→DAL)
  (
    'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    'car_001',
    'Ricardo',
    'Mendoza',
    '(555) 701-1001',
    'r.mendoza@fasthaullogistics.com',
    '482916',
    'on_load',
    32.7767,    -- near Dallas, TX
    -96.7970,
    NOW() - INTERVAL '12 minutes'
  ),

  -- SwiftMove Transport driver (car_002)
  (
    'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
    'car_002',
    'Tamika',
    'Washington',
    '(555) 702-2002',
    't.washington@swiftmove.com',
    '173504',
    'available',
    34.0522,    -- Los Angeles, CA
    -118.2437,
    NOW() - INTERVAL '2 hours'
  ),

  -- ReliableFreight Inc driver (car_003) — currently on LD-2024-006 (MEM→MIA)
  (
    'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f',
    'car_003',
    'Derek',
    'Sullivan',
    '(555) 703-3003',
    'd.sullivan@reliablefreight.com',
    '629841',
    'on_load',
    30.3322,    -- near Tallahassee, FL (en route MEM→MIA)
    -84.2833,
    NOW() - INTERVAL '8 minutes'
  ),

  -- CrossCountry Haulers driver (car_004) — currently on LD-2024-004 (NYC→BOS)
  (
    'd4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f80',
    'car_004',
    'Angela',
    'Petrova',
    '(555) 704-4004',
    'a.petrova@crosscountryhaulers.com',
    '357208',
    'on_load',
    41.3083,    -- near Hartford, CT (en route NYC→BOS)
    -72.9279,
    NOW() - INTERVAL '5 minutes'
  )
ON CONFLICT (id) DO NOTHING;

-- Link drivers to their active loads
UPDATE loads SET driver_id = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' WHERE id = 'LD-2024-001';
UPDATE loads SET driver_id = 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f' WHERE id = 'LD-2024-006';
UPDATE loads SET driver_id = 'd4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f80' WHERE id = 'LD-2024-004';
