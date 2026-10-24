-- Buyer mobile-number verification and provider ID check. Both sit behind ports that fail closed until a provider is configured.
-- No ID images or document numbers are stored here: only the provider reference and the outcome.

ALTER TABLE buyer_verification ADD COLUMN IF NOT EXISTS phone_e164 TEXT;
-- One verified account per mobile number (stops one phone verifying many accounts).
CREATE UNIQUE INDEX buyer_verification_phone_unique ON buyer_verification(phone_e164) WHERE phone_verified_at IS NOT NULL AND phone_e164 IS NOT NULL;

-- Spam Act 2003 consent to receive the verification SMS. Recorded before any SMS is sent. Insert only.
CREATE TABLE phone_sms_consent (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES app_user(id),
  wording_version TEXT        NOT NULL,
  consented_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX phone_sms_consent_user_idx ON phone_sms_consent(user_id, consented_at);
CREATE TRIGGER phone_sms_consent_append_only
  BEFORE UPDATE OR DELETE ON phone_sms_consent
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- The live code. Only a keyed hash of the code is stored. attempts counts guesses (max 5, enforced in the UPDATE).
CREATE TABLE phone_code (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES app_user(id),
  phone_e164  TEXT        NOT NULL,
  code_hash   CHAR(64)    NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER     NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX phone_code_user_idx ON phone_code(user_id, created_at DESC);

-- Every send / guess / lock-out. Insert only. ip_hash is a SHA-256 of the client IP, never the address.
CREATE TABLE phone_attempt_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES app_user(id),
  event       TEXT        NOT NULL CHECK (event IN ('code_sent','send_failed','code_wrong','code_expired','code_locked','verified','rate_limited')),
  ip_hash     CHAR(64),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX phone_attempt_log_user_idx ON phone_attempt_log(user_id, occurred_at);
CREATE TRIGGER phone_attempt_log_append_only
  BEFORE UPDATE OR DELETE ON phone_attempt_log
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- One row per provider ID-check session. Provider reference and outcome only.
CREATE TABLE id_check_session (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES app_user(id),
  provider_ref TEXT        NOT NULL UNIQUE,
  outcome      TEXT        NOT NULL DEFAULT 'started' CHECK (outcome IN ('started','passed','failed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at   TIMESTAMPTZ
);
CREATE INDEX id_check_session_user_idx ON id_check_session(user_id, created_at);

-- Every start request and every provider result. Insert only. event_id (from the provider) makes webhooks idempotent.
CREATE TABLE id_check_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES app_user(id),
  event        TEXT        NOT NULL CHECK (event IN ('start_requested','start_failed','result_passed','result_failed')),
  provider_ref TEXT,
  event_id     TEXT UNIQUE,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER id_check_log_append_only
  BEFORE UPDATE OR DELETE ON id_check_log
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
