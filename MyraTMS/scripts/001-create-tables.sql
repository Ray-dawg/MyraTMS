-- Myra TMS - Core Schema
-- ============================================================

-- Users & Auth
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  role TEXT NOT NULL DEFAULT 'ops' CHECK (role IN ('admin','ops','sales')),
  avatar_url TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Shippers
CREATE TABLE IF NOT EXISTS shippers (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  industry TEXT DEFAULT '',
  pipeline_stage TEXT DEFAULT 'Prospect',
  contract_status TEXT DEFAULT 'Prospect' CHECK (contract_status IN ('Contracted','One-off','Prospect')),
  annual_revenue NUMERIC DEFAULT 0,
  assigned_rep TEXT DEFAULT '',
  last_activity TIMESTAMPTZ DEFAULT now(),
  conversion_probability INT DEFAULT 0,
  contact_name TEXT DEFAULT '',
  contact_email TEXT DEFAULT '',
  contact_phone TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Carriers
CREATE TABLE IF NOT EXISTS carriers (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  mc_number TEXT DEFAULT '',
  dot_number TEXT DEFAULT '',
  insurance_status TEXT DEFAULT 'Active' CHECK (insurance_status IN ('Active','Expiring','Expired')),
  performance_score INT DEFAULT 85,
  on_time_percent INT DEFAULT 90,
  lanes_covered TEXT[] DEFAULT '{}',
  risk_flag BOOLEAN DEFAULT false,
  contact_name TEXT DEFAULT '',
  contact_phone TEXT DEFAULT '',
  -- FMCSA Compliance
  authority_status TEXT DEFAULT 'Active' CHECK (authority_status IN ('Active','Inactive','Revoked')),
  insurance_expiry DATE,
  liability_insurance NUMERIC DEFAULT 0,
  cargo_insurance NUMERIC DEFAULT 0,
  safety_rating TEXT DEFAULT 'Not Rated' CHECK (safety_rating IN ('Satisfactory','Conditional','Unsatisfactory','Not Rated')),
  last_fmcsa_sync TIMESTAMPTZ DEFAULT now(),
  vehicle_oos_percent NUMERIC DEFAULT 0,
  driver_oos_percent NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Loads
CREATE TABLE IF NOT EXISTS loads (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  shipper_id TEXT REFERENCES shippers(id) ON DELETE SET NULL,
  shipper_name TEXT DEFAULT '',
  carrier_id TEXT REFERENCES carriers(id) ON DELETE SET NULL,
  carrier_name TEXT DEFAULT '',
  source TEXT DEFAULT 'Load Board' CHECK (source IN ('Load Board','Contract Shipper','One-off Shipper')),
  status TEXT DEFAULT 'Booked' CHECK (status IN ('Booked','Dispatched','In Transit','Delivered','Invoiced','Closed')),
  revenue NUMERIC DEFAULT 0,
  carrier_cost NUMERIC DEFAULT 0,
  margin NUMERIC DEFAULT 0,
  margin_percent NUMERIC DEFAULT 0,
  pickup_date DATE,
  delivery_date DATE,
  assigned_rep TEXT DEFAULT '',
  equipment TEXT DEFAULT '',
  weight TEXT DEFAULT '',
  risk_flag BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Invoices
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  load_id TEXT REFERENCES loads(id) ON DELETE CASCADE,
  shipper_name TEXT DEFAULT '',
  amount NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'Pending' CHECK (status IN ('Pending','Sent','Paid','Overdue')),
  issue_date DATE,
  due_date DATE,
  factoring_status TEXT DEFAULT 'N/A' CHECK (factoring_status IN ('N/A','Submitted','Approved','Funded')),
  days_outstanding INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Documents
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('BOL','POD','Rate Confirmation','Insurance','Contract','Invoice')),
  related_to TEXT DEFAULT '',
  related_type TEXT DEFAULT 'Load' CHECK (related_type IN ('Load','Shipper','Carrier')),
  upload_date DATE DEFAULT CURRENT_DATE,
  status TEXT DEFAULT 'Pending Review' CHECK (status IN ('Complete','Missing','Pending Review')),
  uploaded_by TEXT DEFAULT '',
  blob_url TEXT DEFAULT '',
  file_size INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Activity Notes (polymorphic)
CREATE TABLE IF NOT EXISTS activity_notes (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('load','shipper','carrier')),
  entity_id TEXT NOT NULL,
  note_type TEXT NOT NULL CHECK (note_type IN ('phone_call','email','zoom_meeting','field_visit','internal_note')),
  content TEXT NOT NULL,
  contact_person TEXT DEFAULT '',
  duration TEXT DEFAULT '',
  created_by TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT DEFAULT '',
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  type TEXT DEFAULT 'info' CHECK (type IN ('info','warning','success','error')),
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Compliance Alerts
CREATE TABLE IF NOT EXISTS compliance_alerts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  carrier_id TEXT REFERENCES carriers(id) ON DELETE CASCADE,
  carrier_name TEXT DEFAULT '',
  mc_number TEXT DEFAULT '',
  alert_type TEXT NOT NULL,
  severity TEXT DEFAULT 'info' CHECK (severity IN ('critical','warning','info')),
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  detected_at TIMESTAMPTZ DEFAULT now(),
  resolved BOOLEAN DEFAULT false
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_loads_status ON loads(status);
CREATE INDEX IF NOT EXISTS idx_loads_shipper ON loads(shipper_id);
CREATE INDEX IF NOT EXISTS idx_loads_carrier ON loads(carrier_id);
CREATE INDEX IF NOT EXISTS idx_invoices_load ON invoices(load_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_notes(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_documents_related ON documents(related_type, related_to);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_compliance_carrier ON compliance_alerts(carrier_id);
