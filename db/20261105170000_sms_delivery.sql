-- SMS delivery tracking: one row per text sent for a notification (state, segments, cost) and an insert-only log of every status change.
-- No message body and no phone number are stored here; the recipient is the user id only.

CREATE TABLE sms_message (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES app_user(id) ON DELETE SET NULL,
  template        TEXT NOT NULL CHECK (template ~ '^[a-z_]{1,40}$'),
  provider_ref    TEXT UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('queued','sent','delivered','undelivered','failed')),
  error_code      TEXT CHECK (error_code ~ '^[a-z0-9_]{1,40}$'),
  segments        INTEGER NOT NULL CHECK (segments BETWEEN 1 AND 10),
  -- Millionths of a dollar. est_cost_micros is segments x the configured rate; price_micros is the provider's own figure when it reports one.
  est_cost_micros BIGINT NOT NULL DEFAULT 0 CHECK (est_cost_micros >= 0),
  price_micros    BIGINT CHECK (price_micros IS NULL OR price_micros >= 0),
  price_unit      TEXT CHECK (price_unit IS NULL OR price_unit ~ '^[A-Z]{3}$'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ
);
CREATE INDEX sms_message_user_idx ON sms_message(user_id, created_at DESC);
CREATE INDEX sms_message_created_idx ON sms_message(created_at);

-- Audit trail of status changes reported by the provider. Insert-only.
CREATE TABLE sms_status_event (
  id            BIGSERIAL PRIMARY KEY,
  provider_ref  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('queued','sent','delivered','undelivered','failed')),
  error_code    TEXT CHECK (error_code ~ '^[a-z0-9_]{1,40}$'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sms_status_event_ref_idx ON sms_status_event(provider_ref);

CREATE FUNCTION sms_status_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'sms_status_event is insert-only'; END $$;
CREATE TRIGGER sms_status_event_no_change BEFORE UPDATE OR DELETE ON sms_status_event
  FOR EACH ROW EXECUTE FUNCTION sms_status_event_immutable();
CREATE TRIGGER sms_status_event_no_truncate BEFORE TRUNCATE ON sms_status_event
  FOR EACH STATEMENT EXECUTE FUNCTION sms_status_event_immutable();

-- A person replying STOP switches their texts off; that is a withdrawal of consent and goes in the consent log like any other.
ALTER TABLE notification_consent_log DROP CONSTRAINT notification_consent_log_source_check;
ALTER TABLE notification_consent_log ADD CONSTRAINT notification_consent_log_source_check
  CHECK (source IN ('settings','unsubscribe_link','suggestion','sms_stop'));
