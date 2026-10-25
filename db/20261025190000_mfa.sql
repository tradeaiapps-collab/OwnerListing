-- Multi-factor sign-in (authenticator app or SMS) on top of Google sign-in. Required for owners and agents; optional for others.
-- Secrets: the authenticator secret is sealed (AES-256-GCM under MFA_SECRET_KEY); codes and recovery codes are kept only as keyed hashes.

-- One row per enrolled method. A factor is usable once confirmed_at is set and until revoked_at is set. Rows are never deleted.
CREATE TABLE mfa_factor (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES app_user(id),
  kind           TEXT        NOT NULL CHECK (kind IN ('totp','sms')),
  -- totp: sealed base32 secret. sms: NULL.
  secret_sealed  TEXT,
  -- sms: +614XXXXXXXX. totp: NULL.
  phone_e164     TEXT,
  -- Highest TOTP time step accepted so far: a code can never be used twice.
  last_used_step BIGINT      NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at   TIMESTAMPTZ,
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  CHECK ((kind = 'totp' AND secret_sealed IS NOT NULL AND phone_e164 IS NULL) OR (kind = 'sms' AND phone_e164 IS NOT NULL AND secret_sealed IS NULL))
);
-- At most one live method of each kind per user (an unconfirmed set-up counts until it is replaced).
CREATE UNIQUE INDEX mfa_factor_one_live_kind ON mfa_factor(user_id, kind) WHERE revoked_at IS NULL;
CREATE INDEX mfa_factor_user_idx ON mfa_factor(user_id);

-- A one-time SMS code (set-up or sign-in). Only a keyed hash is stored. attempts counts guesses (max 5, enforced in the UPDATE).
CREATE TABLE mfa_sms_code (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES app_user(id),
  factor_id   UUID        NOT NULL REFERENCES mfa_factor(id),
  code_hash   CHAR(64)    NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER     NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mfa_sms_code_user_idx ON mfa_sms_code(user_id, created_at DESC);

-- Single-use recovery codes, issued as a set of 10. A new set retires the old one (retired_at). Keyed hash only.
CREATE TABLE mfa_recovery_code (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES app_user(id),
  code_hash  CHAR(64)    NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at    TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  UNIQUE (user_id, code_hash)
);

-- Every enrolment, sign-in check, failure and removal. Insert only. ip_hash is a keyed hash of the client IP, never the address.
CREATE TABLE mfa_event_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES app_user(id),
  event       TEXT        NOT NULL CHECK (event IN ('setup_started','enrolled','verified','code_wrong','code_expired','code_locked',
                                                      'code_sent','send_failed','recovery_used','recovery_regenerated','factor_removed','rate_limited')),
  method      TEXT        CHECK (method IN ('totp','sms','recovery')),
  ip_hash     CHAR(64),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mfa_event_log_user_idx ON mfa_event_log(user_id, occurred_at);
CREATE TRIGGER mfa_event_log_append_only
  BEFORE UPDATE OR DELETE ON mfa_event_log
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
