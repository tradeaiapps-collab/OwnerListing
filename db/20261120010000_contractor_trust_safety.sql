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

-- ---------- Reports against a contractor ----------
CREATE TABLE contractor_report (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id       UUID NOT NULL REFERENCES job_assignment(id),
  reporter_user_id    UUID NOT NULL REFERENCES app_user(id),
  contractor_user_id  UUID NOT NULL REFERENCES app_user(id),
  kind                TEXT NOT NULL CHECK (kind IN ('no_show', 'poor_work', 'unsafe', 'other')),
  detail              TEXT NOT NULL CHECK (char_length(detail) BETWEEN 10 AND 1500),
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'upheld')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by          UUID REFERENCES app_user(id),
  decided_at          TIMESTAMPTZ,
  decision_note       TEXT CHECK (decision_note IS NULL OR char_length(decision_note) <= 500),
  CHECK ((status = 'open') = (decided_at IS NULL)),
  CHECK (decided_by IS NULL OR (decided_by <> reporter_user_id AND decided_by <> contractor_user_id))
);
-- The same complaint about the same job is one open report.
CREATE UNIQUE INDEX contractor_report_open_idx ON contractor_report (assignment_id, kind) WHERE status = 'open';
CREATE INDEX contractor_report_queue_idx ON contractor_report (status, created_at);
CREATE INDEX contractor_report_contractor_idx ON contractor_report (contractor_user_id);

CREATE OR REPLACE FUNCTION contractor_report_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'contractor_report rows are permanent'; END IF;
  IF OLD.status <> 'open' THEN RAISE EXCEPTION 'contractor_report is already decided'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER contractor_report_guard BEFORE UPDATE OR DELETE ON contractor_report FOR EACH ROW EXECUTE FUNCTION contractor_report_guard();

CREATE TABLE contractor_standing_event (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_user_id UUID NOT NULL REFERENCES app_user(id),
  report_id          UUID REFERENCES contractor_report(id),
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

-- ---------- Reviews ----------
CREATE TABLE contractor_review (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id       UUID NOT NULL UNIQUE REFERENCES job_assignment(id),
  owner_user_id       UUID NOT NULL REFERENCES app_user(id),
  contractor_user_id  UUID NOT NULL REFERENCES app_user(id),
  rating              SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment             TEXT CHECK (comment IS NULL OR char_length(comment) BETWEEN 1 AND 1500),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  reply               TEXT CHECK (reply IS NULL OR char_length(reply) BETWEEN 1 AND 1000),
  replied_at          TIMESTAMPTZ,
  CHECK ((reply IS NULL) = (replied_at IS NULL))
);
CREATE INDEX contractor_review_contractor_idx ON contractor_review (contractor_user_id, created_at DESC);

-- A review is permanent. The only change allowed after posting is the contractor's single public reply.
CREATE OR REPLACE FUNCTION contractor_review_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'contractor_review rows are permanent'; END IF;
  IF OLD.reply IS NOT NULL THEN RAISE EXCEPTION 'the contractor has already replied'; END IF;
  IF NEW.assignment_id <> OLD.assignment_id OR NEW.owner_user_id <> OLD.owner_user_id OR NEW.contractor_user_id <> OLD.contractor_user_id
     OR NEW.rating <> OLD.rating OR NEW.comment IS DISTINCT FROM OLD.comment OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a review cannot be edited';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER contractor_review_guard BEFORE UPDATE OR DELETE ON contractor_review FOR EACH ROW EXECUTE FUNCTION contractor_review_guard();
