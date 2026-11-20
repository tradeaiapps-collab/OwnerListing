-- Contractor trust and safety: verification (details the contractor supplies, staff verify), standing (suspension), owner reports,
-- written quotes, photo usage rights and reviews. No external registry is called; nothing here is verified except by staff.

-- Event tables below are insert-only.
CREATE OR REPLACE FUNCTION trust_event_permanent() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are permanent', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- ---------- Verification ----------
CREATE TABLE contractor_verification (
  user_id           UUID PRIMARY KEY REFERENCES app_user(id),
  business_name     TEXT NOT NULL CHECK (char_length(business_name) BETWEEN 1 AND 120),
  abn               TEXT NOT NULL CHECK (abn ~ '^[0-9]{11}$'),
  licence_number    TEXT CHECK (licence_number IS NULL OR char_length(licence_number) BETWEEN 1 AND 60),
  licence_authority TEXT CHECK (licence_authority IS NULL OR char_length(licence_authority) BETWEEN 1 AND 120),
  licence_expiry    DATE,
  insurer           TEXT NOT NULL CHECK (char_length(insurer) BETWEEN 1 AND 120),
  policy_number     TEXT NOT NULL CHECK (char_length(policy_number) BETWEEN 1 AND 60),
  insurance_expiry  DATE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  review_note       TEXT CHECK (review_note IS NULL OR char_length(review_note) <= 500),
  reviewed_by       UUID REFERENCES app_user(id),
  reviewed_at       TIMESTAMPTZ,
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((licence_number IS NULL) = (licence_authority IS NULL)),
  CHECK ((status = 'pending') = (reviewed_at IS NULL)),
  CHECK (reviewed_by IS NULL OR reviewed_by <> user_id)
);
CREATE INDEX contractor_verification_status_idx ON contractor_verification (status, submitted_at);

CREATE TABLE contractor_verification_event (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES app_user(id),
  actor_id   UUID NOT NULL REFERENCES app_user(id),
  action     TEXT NOT NULL CHECK (action IN ('submit', 'verify', 'reject')),
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX contractor_verification_event_idx ON contractor_verification_event (user_id, created_at);
CREATE TRIGGER contractor_verification_event_guard BEFORE UPDATE OR DELETE ON contractor_verification_event FOR EACH ROW EXECUTE FUNCTION trust_event_permanent();

-- ---------- Standing (suspension) ----------
CREATE TABLE contractor_standing (
  user_id    UUID PRIMARY KEY REFERENCES app_user(id),
  suspended  BOOLEAN NOT NULL DEFAULT false,
  reason     TEXT CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  changed_by UUID REFERENCES app_user(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT suspended OR reason IS NOT NULL)
);

-- ---------- Review of owner complaints ----------
-- contractor_complaint (db/20261120100000, contractor operations) is the one complaint table. Staff decide each complaint once.
-- The contractor is the assignment's contractor; staff cannot decide a complaint on a job they are a party to (checked in the update).
ALTER TABLE contractor_complaint
  ADD COLUMN status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'upheld')),
  ADD COLUMN decided_by UUID REFERENCES app_user(id),
  ADD COLUMN decided_at TIMESTAMPTZ,
  ADD COLUMN decision_note TEXT CHECK (decision_note IS NULL OR char_length(decision_note) <= 500),
  ADD CONSTRAINT contractor_complaint_decided_chk CHECK ((status = 'open') = (decided_at IS NULL)),
  ADD CONSTRAINT contractor_complaint_decider_chk CHECK (decided_by IS NULL OR decided_by <> reported_by);
CREATE INDEX contractor_complaint_queue_idx ON contractor_complaint (status, created_at);

CREATE OR REPLACE FUNCTION contractor_complaint_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'contractor_complaint rows are permanent'; END IF;
  IF OLD.status <> 'open' THEN RAISE EXCEPTION 'contractor_complaint is already decided'; END IF;
  IF NEW.assignment_id <> OLD.assignment_id OR NEW.reported_by <> OLD.reported_by OR NEW.kind <> OLD.kind OR NEW.details <> OLD.details OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a complaint cannot be edited';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER contractor_complaint_guard BEFORE UPDATE OR DELETE ON contractor_complaint FOR EACH ROW EXECUTE FUNCTION contractor_complaint_guard();

CREATE TABLE contractor_standing_event (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_user_id UUID NOT NULL REFERENCES app_user(id),
  report_id          UUID REFERENCES contractor_complaint(id),
  actor_id           UUID NOT NULL REFERENCES app_user(id),
  action             TEXT NOT NULL CHECK (action IN ('raised', 'dismiss', 'uphold', 'suspend', 'reinstate')),
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX contractor_standing_event_idx ON contractor_standing_event (contractor_user_id, created_at);
CREATE TRIGGER contractor_standing_event_guard BEFORE UPDATE OR DELETE ON contractor_standing_event FOR EACH ROW EXECUTE FUNCTION trust_event_permanent();

-- ---------- Photographer usage rights, stored with the job ----------
ALTER TABLE job_assignment
  ADD COLUMN usage_rights_confirmed_at TIMESTAMPTZ,
  ADD COLUMN usage_rights_version SMALLINT;

-- ---------- Written quotes ----------
CREATE TABLE job_quote (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id       UUID NOT NULL REFERENCES job_assignment(id),
  contractor_user_id  UUID NOT NULL REFERENCES app_user(id),
  amount_cents        BIGINT NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000),
  description         TEXT NOT NULL CHECK (char_length(description) BETWEEN 10 AND 2000),
  status              TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'accepted', 'declined', 'withdrawn')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at          TIMESTAMPTZ,
  CHECK ((status IN ('accepted', 'declined')) = (decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX job_quote_one_sent_idx ON job_quote (assignment_id) WHERE status = 'sent';
CREATE UNIQUE INDEX job_quote_one_accepted_idx ON job_quote (assignment_id) WHERE status = 'accepted';
CREATE INDEX job_quote_assignment_idx ON job_quote (assignment_id, created_at);

CREATE OR REPLACE FUNCTION job_quote_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'job_quote rows are permanent'; END IF;
  IF OLD.status <> 'sent' THEN RAISE EXCEPTION 'job_quote is already decided'; END IF;
  IF NEW.amount_cents <> OLD.amount_cents OR NEW.description <> OLD.description OR NEW.assignment_id <> OLD.assignment_id THEN
    RAISE EXCEPTION 'a sent quote cannot be edited; withdraw it and send a new one';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER job_quote_guard BEFORE UPDATE OR DELETE ON job_quote FOR EACH ROW EXECUTE FUNCTION job_quote_guard();

-- ---------- Reviews: the contractor's single public reply ----------
-- contractor_review (db/20261120000000, contractor marketplace) holds one owner review per completed job. Here it gains one contractor reply.
ALTER TABLE contractor_review
  ADD COLUMN reply TEXT CHECK (reply IS NULL OR char_length(reply) BETWEEN 1 AND 1000),
  ADD COLUMN replied_at TIMESTAMPTZ,
  ADD CONSTRAINT contractor_review_reply_chk CHECK ((reply IS NULL) = (replied_at IS NULL));

-- A review is permanent. After posting, only the contractor's single reply (and staff hiding it) can change.
CREATE OR REPLACE FUNCTION contractor_review_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'contractor_review rows are permanent'; END IF;
  IF NEW.assignment_id <> OLD.assignment_id OR NEW.owner_user_id <> OLD.owner_user_id OR NEW.contractor_user_id <> OLD.contractor_user_id
     OR NEW.rating <> OLD.rating OR NEW.body IS DISTINCT FROM OLD.body OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a review cannot be edited';
  END IF;
  IF OLD.reply IS NOT NULL AND (NEW.reply IS DISTINCT FROM OLD.reply OR NEW.replied_at IS DISTINCT FROM OLD.replied_at) THEN
    RAISE EXCEPTION 'the contractor has already replied';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER contractor_review_guard BEFORE UPDATE OR DELETE ON contractor_review FOR EACH ROW EXECUTE FUNCTION contractor_review_guard();
