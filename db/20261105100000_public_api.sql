-- Public API platform: API keys (also used as OAuth 2.0 client credentials), webhook endpoints, the event outbox and a usage log.

-- One row per API key. The secret is shown once and only its SHA-256 is kept (the secret is 256 random bits, so a fast hash is safe).
CREATE TABLE api_key (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES app_user(id),
  public_id    TEXT        NOT NULL UNIQUE CHECK (public_id ~ '^olk_[a-z0-9]{12}$'),
  secret_hash  CHAR(64)    NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  name         TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  scopes       TEXT[]      NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 10),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX api_key_user_idx ON api_key(user_id, created_at DESC);

-- Where a user wants events sent. The signing secret is kept so each delivery can be signed; it is shown once on creation.
CREATE TABLE api_webhook_endpoint (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID        NOT NULL REFERENCES app_user(id),
  url                  TEXT        NOT NULL CHECK (char_length(url) <= 500 AND url ~ '^https://'),
  secret               TEXT        NOT NULL,
  events               TEXT[]      NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 20),
  active               BOOLEAN     NOT NULL DEFAULT true,
  consecutive_failures INTEGER     NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at          TIMESTAMPTZ
);
CREATE INDEX api_webhook_endpoint_user_idx ON api_webhook_endpoint(user_id) WHERE active;

-- Events are recorded by triggers on the source tables, so every code path emits them. owner_user_id is who may receive the event.
-- Payloads carry ids and statuses only: never message text, offer terms, contact details or documents.
CREATE TABLE api_event (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    TEXT        NOT NULL,
  owner_user_id UUID        NOT NULL REFERENCES app_user(id),
  payload       JSONB       NOT NULL,
  fanned_out_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_event_pending_idx ON api_event(created_at) WHERE fanned_out_at IS NULL;

CREATE TABLE api_webhook_delivery (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id     UUID        NOT NULL REFERENCES api_webhook_endpoint(id) ON DELETE CASCADE,
  event_id        UUID        NOT NULL REFERENCES api_event(id),
  state           TEXT        NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','failed')),
  attempts        INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status     INTEGER,
  last_error      TEXT,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX api_webhook_delivery_due_idx ON api_webhook_delivery(next_attempt_at) WHERE state = 'pending';

-- One row per authenticated API call (key id, route template, status). Feeds rate limiting and the usage insights.
CREATE TABLE api_request_log (
  id      BIGSERIAL   PRIMARY KEY,
  key_id  UUID        NOT NULL REFERENCES api_key(id),
  route   TEXT        NOT NULL,
  method  TEXT        NOT NULL,
  status  SMALLINT    NOT NULL,
  at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_request_log_key_idx ON api_request_log(key_id, at DESC);

-- Event triggers. Statements are plain inserts; failure to record an event must never block the business write, so they cannot raise.
CREATE OR REPLACE FUNCTION api_emit_listing_published() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'published' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'published') THEN
    INSERT INTO api_event (event_type, owner_user_id, payload)
    VALUES ('listing.published', NEW.owner_user_id, jsonb_build_object('listingId', NEW.id, 'title', NEW.title, 'transactionType', NEW.transaction_type));
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER api_listing_published AFTER INSERT OR UPDATE OF status ON property_listing
  FOR EACH ROW EXECUTE FUNCTION api_emit_listing_published();

CREATE OR REPLACE FUNCTION api_emit_offer_submitted() RETURNS trigger AS $$
DECLARE o UUID;
BEGIN
  SELECT owner_user_id INTO o FROM property_listing WHERE id = NEW.listing_id;
  IF o IS NOT NULL THEN
    INSERT INTO api_event (event_type, owner_user_id, payload)
    VALUES ('offer.submitted', o, jsonb_build_object('offerId', NEW.id, 'listingId', NEW.listing_id, 'status', NEW.status));
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER api_offer_submitted AFTER INSERT ON formal_offer
  FOR EACH ROW EXECUTE FUNCTION api_emit_offer_submitted();

CREATE OR REPLACE FUNCTION api_emit_message_created() RETURNS trigger AS $$
DECLARE o UUID; l UUID;
BEGIN
  SELECT p.owner_user_id, p.id INTO o, l FROM enquiry e JOIN property_listing p ON p.id = e.listing_id WHERE e.id = NEW.enquiry_id;
  IF o IS NOT NULL AND NEW.automated = false THEN
    INSERT INTO api_event (event_type, owner_user_id, payload)
    VALUES ('message.created', o, jsonb_build_object('messageId', NEW.id, 'enquiryId', NEW.enquiry_id, 'listingId', l));
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER api_message_created AFTER INSERT ON enquiry_message
  FOR EACH ROW EXECUTE FUNCTION api_emit_message_created();

CREATE OR REPLACE FUNCTION api_emit_appointment_created() RETURNS trigger AS $$
DECLARE o UUID;
BEGIN
  SELECT owner_user_id INTO o FROM property_listing WHERE id = NEW.listing_id;
  IF o IS NOT NULL THEN
    INSERT INTO api_event (event_type, owner_user_id, payload)
    VALUES ('appointment.created', o, jsonb_build_object('appointmentId', NEW.id, 'listingId', NEW.listing_id, 'scope', NEW.scope));
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER api_appointment_created AFTER INSERT ON listing_agent_appointment
  FOR EACH ROW EXECUTE FUNCTION api_emit_appointment_created();
