-- Provider credentials entered by staff in the admin screen (first user: the Domain API for property feeds).
-- The secret is stored sealed (AES-256-GCM, bound to the provider name); the client id is not secret. One row per provider.
-- Environment variables stay as a fallback when no row exists.
CREATE TABLE provider_credential (
  provider TEXT PRIMARY KEY CHECK (provider IN ('domain')),
  client_id TEXT NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 200),
  secret_sealed TEXT NOT NULL CHECK (char_length(secret_sealed) BETWEEN 1 AND 2000),
  last_tested_at TIMESTAMPTZ,
  last_test_ok BOOLEAN,
  last_test_error TEXT CHECK (last_test_error IS NULL OR char_length(last_test_error) <= 300),
  updated_by UUID REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
