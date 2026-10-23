-- Data foundation. Property facts are kept separate from personal data so a future
-- property-data product can be built on the property side without exposing people.
-- Store files (photos, reports) in our own object storage; the database holds keys and hashes.

CREATE TABLE property (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address_text TEXT NOT NULL,
  gnaf_pid TEXT UNIQUE,                       -- national address identifier when matched
  state CHAR(3) NOT NULL CHECK (state IN ('NSW','VIC','QLD','WA','SA','TAS','ACT','NT')),
  suburb TEXT, postcode CHAR(4),
  use_class TEXT CHECK (use_class IN ('residential','commercial')),
  property_type TEXT CHECK (property_type IN ('house','unit','townhouse','land','office','retail','industrial','warehouse','hospitality','other')),
  bedrooms SMALLINT, bathrooms SMALLINT, car_spaces SMALLINT, land_area_sqm NUMERIC,
  latitude NUMERIC, longitude NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE property_listing ADD COLUMN property_id UUID REFERENCES property(id);

-- History of what happened to a property. Insert only: price history and sales build up over time.
CREATE TABLE property_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES property(id),
  listing_id UUID REFERENCES property_listing(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('listed','price_changed','offer_received','sold','withdrawn','rented','inspected','report_added')),
  occurred_at TIMESTAMPTZ NOT NULL,
  amount_cents BIGINT,
  source TEXT NOT NULL CHECK (source IN ('platform','owner_supplied','licensed_third_party','public_record')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX property_event_idx ON property_event(property_id, occurred_at);

-- Files: title searches, inspection and pest reports, contracts, photos, floorplans.
CREATE TABLE property_document (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES property(id),
  listing_id UUID REFERENCES property_listing(id),
  kind TEXT NOT NULL CHECK (kind IN ('title_search','building_inspection','pest_report','contract','photo','photo_360','video','video_360','floorplan','other')),
  storage_key TEXT NOT NULL,
  sha256 CHAR(64) NOT NULL,
  uploaded_by UUID NOT NULL REFERENCES app_user(id),
  source TEXT NOT NULL CHECK (source IN ('platform','owner_supplied','licensed_third_party','public_record')),
  -- Third-party data usually cannot be reused or resold. Default is no; only set true with confirmed rights.
  reusable_for_analytics BOOLEAN NOT NULL DEFAULT false,
  licence_terms TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Admin's choice of AI engine. Insert a new row to change; latest row wins.
CREATE TABLE ai_engine_setting (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  engine TEXT NOT NULL CHECK (engine IN ('prompts_templates','trained_model')),
  changed_by UUID NOT NULL REFERENCES app_user(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Human decisions and actions, collected only with consent, with no names or contact details.
CREATE TABLE ai_learning_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  area TEXT NOT NULL CHECK (area IN ('negotiation','enquiry','contract','broker')),
  ai_suggestion TEXT NOT NULL,
  human_action TEXT NOT NULL CHECK (human_action IN ('accepted','edited','rejected','took_over')),
  human_final_text TEXT,
  situation JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cases an admin must take over (for example, failed automated bank verification).
CREATE TABLE admin_case (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('trust_account_verification','licence_verification','identity_verification','other')),
  subject_id UUID NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  assigned_to UUID REFERENCES app_user(id),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
