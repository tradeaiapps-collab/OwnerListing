-- Contractor marketplace (package 1): public contractor page, priced services, gallery, owner reviews, job numbers and job offer details.
-- Contractors are paid directly by the owner outside the platform; the price shown is the contractor's own displayed price only.
CREATE SEQUENCE IF NOT EXISTS contractor_number_seq START 2001;
CREATE SEQUENCE IF NOT EXISTS job_number_seq START 5001;

CREATE TABLE contractor_page (
  user_id UUID PRIMARY KEY REFERENCES app_user(id),
  contractor_no INTEGER NOT NULL UNIQUE DEFAULT nextval('contractor_number_seq'),
  business_name TEXT CHECK (business_name IS NULL OR char_length(business_name) <= 100),
  headline TEXT CHECK (headline IS NULL OR char_length(headline) <= 140),
  about TEXT CHECK (about IS NULL OR char_length(about) <= 3000),
  trade_label TEXT CHECK (trade_label IS NULL OR char_length(trade_label) <= 60),
  licence_number TEXT CHECK (licence_number IS NULL OR char_length(licence_number) <= 40),
  licence_state CHAR(3) CHECK (licence_state IS NULL OR licence_state IN ('NSW','VIC','QLD','WA','SA','TAS','ACT','NT')),
  -- Set by staff after checking the licence. The badge shows only when this is set.
  licence_verified_at TIMESTAMPTZ,
  is_public BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO contractor_page (user_id) SELECT DISTINCT user_id FROM contractor_profile ON CONFLICT DO NOTHING;

CREATE TABLE contractor_service (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_user(id),
  kind TEXT NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 500),
  price_cents INTEGER NOT NULL CHECK (price_cents BETWEEN 0 AND 100000000),
  price_type TEXT NOT NULL DEFAULT 'fixed' CHECK (price_type IN ('fixed','from','per_hour')),
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX contractor_service_user_idx ON contractor_service (user_id, kind);

CREATE TABLE contractor_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_user(id),
  media_type TEXT NOT NULL CHECK (media_type IN ('photo','video')),
  url TEXT NOT NULL CHECK (url ~ '^https://' AND char_length(url) <= 500),
  caption TEXT CHECK (caption IS NULL OR char_length(caption) <= 140),
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX contractor_media_user_idx ON contractor_media (user_id);

-- Trades beyond photographer and inspector: pest control, and other trades named by the contractor.
ALTER TABLE contractor_profile DROP CONSTRAINT IF EXISTS contractor_profile_kind_check;
ALTER TABLE contractor_profile ADD CONSTRAINT contractor_profile_kind_check CHECK (kind IN ('photographer','inspector','pest_control','other'));
ALTER TABLE job_assignment DROP CONSTRAINT IF EXISTS job_assignment_kind_check;
ALTER TABLE job_assignment ADD CONSTRAINT job_assignment_kind_check CHECK (kind IN ('photographer','solicitor','inspector','agent','pest_control','other'));

ALTER TABLE job_assignment
  ADD COLUMN job_number INTEGER NOT NULL UNIQUE DEFAULT nextval('job_number_seq'),
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN offer_source TEXT NOT NULL DEFAULT 'owner' CHECK (offer_source IN ('owner','elena')),
  ADD COLUMN service_name TEXT,
  ADD COLUMN price_cents INTEGER,
  ADD COLUMN note TEXT CHECK (note IS NULL OR char_length(note) <= 1000),
  ADD COLUMN requested_time TIMESTAMPTZ,
  ADD COLUMN proposed_time TIMESTAMPTZ,
  ADD COLUMN scheduled_time TIMESTAMPTZ,
  ADD COLUMN decline_reason TEXT CHECK (decline_reason IS NULL OR char_length(decline_reason) <= 500),
  ADD COLUMN responded_at TIMESTAMPTZ,
  ADD COLUMN contractor_done_at TIMESTAMPTZ,
  ADD COLUMN completed_at TIMESTAMPTZ;
CREATE INDEX job_assignment_contractor_idx ON job_assignment (contractor_user_id, created_at DESC);

-- One feedback per completed job, from the owner. Kept permanently.
CREATE TABLE contractor_review (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL UNIQUE REFERENCES job_assignment(id),
  contractor_user_id UUID NOT NULL REFERENCES app_user(id),
  owner_user_id UUID NOT NULL REFERENCES app_user(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT CHECK (body IS NULL OR char_length(body) <= 1000),
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX contractor_review_contractor_idx ON contractor_review (contractor_user_id, created_at DESC);
