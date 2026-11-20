-- Elena for rentals: tenant application screening, viewings, and tenant repair requests.
-- Elena summarises and flags; the owner decides. Nothing here deletes a person's record; messages are insert-only.

-- Per rental listing: switches and the owner's stated criteria. Criteria are only these four: rent against income, rental history, references, move-in window.
CREATE TABLE rental_settings (
  listing_id UUID PRIMARY KEY REFERENCES property_listing(id),
  elena_on BOOLEAN NOT NULL DEFAULT false,
  max_rent_pct INTEGER NOT NULL DEFAULT 35 CHECK (max_rent_pct BETWEEN 10 AND 100),
  min_history_months INTEGER NOT NULL DEFAULT 0 CHECK (min_history_months BETWEEN 0 AND 120),
  min_references INTEGER NOT NULL DEFAULT 0 CHECK (min_references BETWEEN 0 AND 5),
  move_in_from DATE,
  move_in_to DATE,
  -- Elena sends the job offer for a repair herself instead of asking the owner first. Off unless the owner turns it on.
  auto_repair_offers BOOLEAN NOT NULL DEFAULT false,
  -- Elena sends an emergency request to emergency contractors herself when a tenant reports an emergency. Off unless the owner turns it on.
  auto_emergency BOOLEAN NOT NULL DEFAULT false,
  updated_by UUID NOT NULL REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (move_in_from IS NULL OR move_in_to IS NULL OR move_in_to >= move_in_from)
);

CREATE TABLE rental_viewing_slot (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  starts_at TIMESTAMPTZ NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 15 CHECK (duration_min BETWEEN 10 AND 60),
  capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 6),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','cancelled')),
  summary_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id, starts_at)
);
CREATE INDEX rental_viewing_slot_listing_idx ON rental_viewing_slot (listing_id, starts_at);

-- An application. Owner decisions are only 'shortlisted', 'approved' and 'declined'; Elena never sets them.
-- The note is the applicant's own words; it is stored but withheld from the owner when it names a protected attribute or contact details.
CREATE TABLE rental_application (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  applicant_user_id UUID NOT NULL REFERENCES app_user(id),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','info_requested','shortlisted','approved','declined','withdrawn')),
  weekly_income_cents INTEGER CHECK (weekly_income_cents IS NULL OR weekly_income_cents BETWEEN 1 AND 100000000),
  rental_history_months INTEGER CHECK (rental_history_months IS NULL OR rental_history_months BETWEEN 0 AND 600),
  references_count INTEGER CHECK (references_count IS NULL OR references_count BETWEEN 0 AND 10),
  move_in_date DATE,
  note TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  note_withheld BOOLEAN NOT NULL DEFAULT false,
  info_requests INTEGER NOT NULL DEFAULT 0,
  last_info_request_at TIMESTAMPTZ,
  decided_by UUID REFERENCES app_user(id),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id, applicant_user_id)
);
CREATE INDEX rental_application_listing_idx ON rental_application (listing_id, created_at);

CREATE TABLE rental_viewing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id UUID NOT NULL REFERENCES rental_viewing_slot(id),
  application_id UUID NOT NULL REFERENCES rental_application(id),
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled','attended','no_show')),
  reminder_24h_at TIMESTAMPTZ,
  reminder_2h_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX rental_viewing_one_booked_idx ON rental_viewing (application_id) WHERE status = 'booked';
CREATE INDEX rental_viewing_slot_idx ON rental_viewing (slot_id) WHERE status = 'booked';

-- A current tenant of a rental listing. Only the owner creates one; it is what lets a person send repair requests.
CREATE TABLE rental_tenancy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  tenant_user_id UUID NOT NULL REFERENCES app_user(id),
  created_by UUID NOT NULL REFERENCES app_user(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id, tenant_user_id)
);

CREATE SEQUENCE rental_repair_seq START 1001;
CREATE TABLE rental_repair (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_no INTEGER NOT NULL UNIQUE DEFAULT nextval('rental_repair_seq'),
  tenancy_id UUID NOT NULL REFERENCES rental_tenancy(id),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  tenant_user_id UUID NOT NULL REFERENCES app_user(id),
  owner_user_id UUID NOT NULL REFERENCES app_user(id),
  category TEXT NOT NULL CHECK (category IN ('plumbing','electrical','gas','appliance','heating_cooling','locks_security','windows_doors','roof_leaks','pests','structure','other')),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 10 AND 1000),
  urgency TEXT NOT NULL CHECK (urgency IN ('emergency','urgent','routine')),
  urgency_reason TEXT NOT NULL,
  trade TEXT,
  status TEXT NOT NULL DEFAULT 'awaiting_owner' CHECK (status IN ('awaiting_owner','offered','scheduled','emergency','owner_arranging','check_in','needs_owner','closed')),
  proposed_contractor_id UUID REFERENCES app_user(id),
  proposed_reasons TEXT[] NOT NULL DEFAULT '{}',
  assignment_id UUID REFERENCES job_assignment(id),
  offered_at TIMESTAMPTZ,
  asked_contractor_ids UUID[] NOT NULL DEFAULT '{}',
  emergency_request_id UUID,
  chases INTEGER NOT NULL DEFAULT 0,
  next_action_at TIMESTAMPTZ,
  tenant_consent_at TIMESTAMPTZ,
  notice_sent_at TIMESTAMPTZ,
  needs_owner_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX rental_repair_due_idx ON rental_repair (next_action_at) WHERE status NOT IN ('closed','needs_owner');
CREATE INDEX rental_repair_listing_idx ON rental_repair (listing_id, created_at DESC);
CREATE INDEX rental_repair_tenant_idx ON rental_repair (tenant_user_id, created_at DESC);

CREATE TABLE rental_repair_photo (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_id UUID NOT NULL REFERENCES rental_repair(id),
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  bytes BYTEA NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 2097152),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rental_repair_photo_repair_idx ON rental_repair_photo (repair_id);

-- Everything Elena sent about a rental. Insert-only: the record the parties can read.
CREATE TABLE rental_message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('application','viewing','repair')),
  subject_id UUID NOT NULL,
  to_user_id UUID NOT NULL REFERENCES app_user(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  status TEXT NOT NULL CHECK (status IN ('sent','blocked','rate_limited','failed')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rental_message_subject_idx ON rental_message (subject_type, subject_id, created_at);
CREATE INDEX rental_message_rate_idx ON rental_message (to_user_id, subject_id, created_at) WHERE status = 'sent';
CREATE TRIGGER rental_message_append_only BEFORE UPDATE OR DELETE ON rental_message FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
