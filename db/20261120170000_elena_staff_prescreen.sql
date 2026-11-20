-- Elena pre-screens the staff queues (moderation, contractor verification, complaints). She only recommends; staff decide.
-- Every recommendation she shows and what staff then did are kept permanently, so her accuracy can be reviewed. No personal text is stored here:
-- the reason sentence cites rules and short matched words only, and the subject id points at the queue row.
CREATE TABLE elena_staff_recommendation (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue       TEXT NOT NULL CHECK (queue IN ('moderation', 'verification', 'complaint')),
  subject_id  UUID NOT NULL,
  fingerprint TEXT NOT NULL CHECK (char_length(fingerprint) BETWEEN 1 AND 80),
  action      TEXT NOT NULL CHECK (action IN ('approve', 'hide', 'suspend', 'needs_info', 'uphold', 'dismiss', 'uphold_and_suspend', 'review')),
  confidence  TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  rule        TEXT NOT NULL CHECK (char_length(rule) BETWEEN 1 AND 60),
  reason      TEXT NOT NULL CHECK (char_length(reason) <= 1000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (queue, subject_id, fingerprint)
);
CREATE INDEX elena_staff_recommendation_subject_idx ON elena_staff_recommendation (queue, subject_id, created_at DESC);

CREATE TABLE elena_staff_outcome (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id UUID REFERENCES elena_staff_recommendation(id),
  queue             TEXT NOT NULL CHECK (queue IN ('moderation', 'verification', 'complaint')),
  subject_id        UUID NOT NULL,
  staff_id          UUID NOT NULL REFERENCES app_user(id),
  staff_action      TEXT NOT NULL CHECK (staff_action IN ('approve', 'hide', 'suspend', 'escalate', 'verify', 'needs_info', 'dismiss', 'uphold', 'uphold_and_suspend')),
  -- true: staff did what Elena suggested; false: staff overrode her; null: Elena had made no call ("review") or there was no recommendation.
  agreed            BOOLEAN,
  via_bulk          BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX elena_staff_outcome_idx ON elena_staff_outcome (queue, created_at DESC);
CREATE INDEX elena_staff_outcome_bulk_idx ON elena_staff_outcome (staff_id, created_at DESC) WHERE via_bulk;

CREATE OR REPLACE FUNCTION elena_staff_rows_permanent() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are permanent', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER elena_staff_recommendation_guard BEFORE UPDATE OR DELETE ON elena_staff_recommendation FOR EACH ROW EXECUTE FUNCTION elena_staff_rows_permanent();
CREATE TRIGGER elena_staff_outcome_guard BEFORE UPDATE OR DELETE ON elena_staff_outcome FOR EACH ROW EXECUTE FUNCTION elena_staff_rows_permanent();
