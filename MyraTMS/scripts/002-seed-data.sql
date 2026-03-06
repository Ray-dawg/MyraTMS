-- Seed Users (password is 'admin123' hashed with bcrypt)
INSERT INTO users (id, email, password_hash, name, role, avatar_url) VALUES
  ('usr_001', 'admin@myra.io', '$2b$10$dummyhashforadmin123456789012345678901234567890', 'Marcus Johnson', 'admin', NULL),
  ('usr_002', 'ops@myra.io', '$2b$10$dummyhashforops12345678901234567890123456789012', 'Sarah Chen', 'ops', NULL),
  ('usr_003', 'sales@myra.io', '$2b$10$dummyhashforsales1234567890123456789012345678901', 'David Park', 'sales', NULL)
ON CONFLICT (email) DO NOTHING;

-- Seed Shippers
INSERT INTO shippers (id, company, industry, contact_name, contact_email, contact_phone, address, pipeline_stage, contract_status, conversion_probability, annual_revenue, assigned_rep, last_contact) VALUES
  ('shp_001', 'Global Foods Inc', 'Food & Beverage', 'Jennifer Martinez', 'j.martinez@globalfoods.com', '(555) 123-4567', '1200 Commerce Dr, Chicago, IL', 'Contracted', 'Contracted', 95, 2400000, 'Marcus Johnson', NOW() - INTERVAL '2 days'),
  ('shp_002', 'TechParts Direct', 'Electronics', 'Robert Kim', 'r.kim@techparts.com', '(555) 234-5678', '890 Innovation Blvd, San Jose, CA', 'Negotiation', 'Pending', 72, 1800000, 'Sarah Chen', NOW() - INTERVAL '1 day'),
  ('shp_003', 'MedSupply Corp', 'Healthcare', 'Lisa Wong', 'l.wong@medsupply.com', '(555) 345-6789', '450 Health Pkwy, Memphis, TN', 'Contracted', 'Contracted', 88, 3200000, 'Marcus Johnson', NOW() - INTERVAL '5 days'),
  ('shp_004', 'AutoWorks MFG', 'Automotive', 'Carlos Rivera', 'c.rivera@autoworks.com', '(555) 456-7890', '2100 Industrial Ave, Detroit, MI', 'Qualification', 'Prospect', 45, 0, 'David Park', NOW() - INTERVAL '3 days'),
  ('shp_005', 'FreshHarvest Co', 'Agriculture', 'Emily Thompson', 'e.thompson@freshharvest.com', '(555) 567-8901', '775 Farm Road, Fresno, CA', 'Proposal', 'Pending', 68, 950000, 'Sarah Chen', NOW() - INTERVAL '7 days')
ON CONFLICT (id) DO NOTHING;

-- Seed Carriers
INSERT INTO carriers (id, company, mc_number, dot_number, insurance_status, insurance_expiry, liability_insurance, cargo_insurance, performance_score, on_time_percent, lanes_covered, risk_flag, contact_name, contact_phone, authority_status, safety_rating, last_fmcsa_sync, vehicle_oos_percent, driver_oos_percent) VALUES
  ('car_001', 'FastHaul Logistics', 'MC-123456', 'USDOT-1234567', 'Active', (NOW() + INTERVAL '200 days')::date, 1000000, 100000, 92, 96, ARRAY['CHI-DAL', 'CHI-ATL', 'DAL-HOU'], false, 'Mike Torres', '(555) 111-2222', 'Active', 'Satisfactory', NOW(), 8.5, 3.2),
  ('car_002', 'SwiftMove Transport', 'MC-234567', 'USDOT-2345678', 'Active', (NOW() + INTERVAL '90 days')::date, 1000000, 100000, 88, 91, ARRAY['LA-PHX', 'LA-LV', 'SF-LA'], false, 'Anna Lee', '(555) 222-3333', 'Active', 'Satisfactory', NOW(), 12.1, 4.8),
  ('car_003', 'ReliableFreight Inc', 'MC-345678', 'USDOT-3456789', 'Expiring', (NOW() + INTERVAL '15 days')::date, 750000, 75000, 85, 88, ARRAY['ATL-MIA', 'ATL-JAX', 'MIA-TPA'], true, 'James Brown', '(555) 333-4444', 'Active', 'Conditional', NOW(), 22.3, 6.1),
  ('car_004', 'CrossCountry Haulers', 'MC-456789', 'USDOT-4567890', 'Active', (NOW() + INTERVAL '300 days')::date, 1000000, 100000, 78, 82, ARRAY['NYC-BOS', 'NYC-PHL', 'BOS-DC'], false, 'Patricia Davis', '(555) 444-5555', 'Active', 'Not Rated', NOW(), 15.0, 5.0),
  ('car_005', 'PrimeRoute LLC', 'MC-567890', 'USDOT-5678901', 'Expired', (NOW() - INTERVAL '10 days')::date, 500000, 50000, 65, 72, ARRAY['SEA-PDX', 'SEA-SF'], true, 'Tom Wilson', '(555) 555-6666', 'Inactive', 'Unsatisfactory', NOW() - INTERVAL '30 days', 35.0, 9.2)
ON CONFLICT (id) DO NOTHING;

-- Seed Loads
INSERT INTO loads (id, shipper_id, carrier_id, status, origin, destination, pickup_date, delivery_date, commodity, weight, equipment_type, revenue, carrier_cost, margin, assigned_rep) VALUES
  ('LD-2024-001', 'shp_001', 'car_001', 'In Transit', 'Chicago, IL', 'Dallas, TX', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', 'Frozen Foods', '42,000 lbs', 'Reefer', 4200, 3200, 23.8, 'Marcus Johnson'),
  ('LD-2024-002', 'shp_002', 'car_002', 'Delivered', 'San Jose, CA', 'Phoenix, AZ', NOW() - INTERVAL '5 days', NOW() - INTERVAL '3 days', 'Electronics', '28,000 lbs', 'Dry Van', 3800, 2900, 23.7, 'Sarah Chen'),
  ('LD-2024-003', 'shp_003', NULL, 'Pending', 'Memphis, TN', 'Atlanta, GA', NOW() + INTERVAL '2 days', NOW() + INTERVAL '4 days', 'Medical Supplies', '35,000 lbs', 'Dry Van', 5200, 3800, 26.9, 'Marcus Johnson'),
  ('LD-2024-004', 'shp_001', 'car_004', 'In Transit', 'New York, NY', 'Boston, MA', NOW(), NOW() + INTERVAL '1 day', 'Packaged Goods', '22,000 lbs', 'Dry Van', 1800, 1200, 33.3, 'David Park'),
  ('LD-2024-005', 'shp_005', 'car_001', 'Delivered', 'Fresno, CA', 'Seattle, WA', NOW() - INTERVAL '7 days', NOW() - INTERVAL '5 days', 'Fresh Produce', '38,000 lbs', 'Reefer', 4800, 3600, 25.0, 'Sarah Chen'),
  ('LD-2024-006', 'shp_003', 'car_003', 'Issue', 'Memphis, TN', 'Miami, FL', NOW() - INTERVAL '2 days', NOW(), 'Pharmaceuticals', '15,000 lbs', 'Temp Controlled', 6200, 4800, 22.6, 'Marcus Johnson'),
  ('LD-2024-007', 'shp_004', NULL, 'Quoted', 'Detroit, MI', 'Chicago, IL', NOW() + INTERVAL '5 days', NOW() + INTERVAL '6 days', 'Auto Parts', '44,000 lbs', 'Flatbed', 2200, 1600, 27.3, 'David Park'),
  ('LD-2024-008', 'shp_002', 'car_002', 'Booked', 'Los Angeles, CA', 'Las Vegas, NV', NOW() + INTERVAL '1 day', NOW() + INTERVAL '2 days', 'Server Equipment', '30,000 lbs', 'Dry Van', 2400, 1800, 25.0, 'Sarah Chen')
ON CONFLICT (id) DO NOTHING;

-- Seed Invoices
INSERT INTO invoices (id, load_id, shipper_id, amount, status, due_date, issued_date) VALUES
  ('INV-001', 'LD-2024-001', 'shp_001', 4200, 'Pending', NOW() + INTERVAL '30 days', NOW()),
  ('INV-002', 'LD-2024-002', 'shp_002', 3800, 'Paid', NOW() - INTERVAL '5 days', NOW() - INTERVAL '35 days'),
  ('INV-003', 'LD-2024-005', 'shp_005', 4800, 'Paid', NOW() - INTERVAL '2 days', NOW() - INTERVAL '32 days'),
  ('INV-004', 'LD-2024-006', 'shp_003', 6200, 'Overdue', NOW() - INTERVAL '5 days', NOW() - INTERVAL '35 days'),
  ('INV-005', 'LD-2024-004', 'shp_001', 1800, 'Pending', NOW() + INTERVAL '25 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- Seed Activity Notes
INSERT INTO activity_notes (entity_type, entity_id, type, content, contact_person, duration, user_id) VALUES
  ('load', 'LD-2024-001', 'phone_call', 'Confirmed pickup appointment for tomorrow at 8AM. Dock #4 assigned.', 'Jennifer Martinez', '5 min', 'usr_001'),
  ('load', 'LD-2024-001', 'email', 'Sent rate confirmation to carrier. Awaiting signed copy.', 'Mike Torres', NULL, 'usr_001'),
  ('load', 'LD-2024-006', 'phone_call', 'Carrier reported 2-hour delay due to weather. Updated ETA communicated to shipper.', 'James Brown', '8 min', 'usr_001'),
  ('shipper', 'shp_001', 'zoom_meeting', 'Quarterly business review. Discussed volume projections for Q2. Expecting 15% increase.', 'Jennifer Martinez', '45 min', 'usr_001'),
  ('shipper', 'shp_002', 'phone_call', 'Initial discovery call. Need temperature-controlled lanes from San Jose to Phoenix.', 'Robert Kim', '20 min', 'usr_002'),
  ('carrier', 'car_001', 'phone_call', 'Discussed adding new lanes CHI-MEM and CHI-STL. Carrier interested at current rates.', 'Mike Torres', '12 min', 'usr_001'),
  ('carrier', 'car_003', 'email', 'Sent insurance renewal reminder. Certificate expires in 15 days. Must update before next dispatch.', 'James Brown', NULL, 'usr_001');

-- Seed Notifications  
INSERT INTO notifications (user_id, title, message, type, priority, entity_type, entity_id) VALUES
  ('usr_001', 'Load LD-2024-006 has an issue', 'Carrier reported weather delay on Memphis to Miami route.', 'alert', 'high', 'load', 'LD-2024-006'),
  ('usr_001', 'Insurance expiring soon', 'ReliableFreight Inc insurance expires in 15 days.', 'warning', 'high', 'carrier', 'car_003'),
  ('usr_001', 'New load delivered', 'LD-2024-002 delivered successfully to Phoenix, AZ.', 'success', 'low', 'load', 'LD-2024-002'),
  ('usr_001', 'Invoice overdue', 'INV-004 for MedSupply Corp is past due.', 'alert', 'medium', 'invoice', 'INV-004'),
  ('usr_002', 'Load ready for dispatch', 'LD-2024-008 is booked and ready for carrier pickup.', 'info', 'medium', 'load', 'LD-2024-008');

-- Seed Compliance Alerts
INSERT INTO compliance_alerts (carrier_id, type, severity, message, due_date) VALUES
  ('car_003', 'insurance_expiring', 'high', 'Liability insurance expires in 15 days. Carrier must renew before next dispatch.', (NOW() + INTERVAL '15 days')::date),
  ('car_005', 'authority_revoked', 'critical', 'Operating authority is Inactive. DO NOT DISPATCH. Carrier must reactivate with FMCSA.', NOW()::date),
  ('car_005', 'insurance_expired', 'critical', 'Insurance has been expired for 10 days. Carrier is non-compliant.', (NOW() - INTERVAL '10 days')::date),
  ('car_003', 'safety_downgrade', 'medium', 'Safety rating downgraded to Conditional. Vehicle OOS rate at 22.3% exceeds national average.', NOW()::date),
  ('car_002', 'insurance_expiring', 'low', 'Insurance expires in 90 days. Schedule renewal reminder.', (NOW() + INTERVAL '90 days')::date);
