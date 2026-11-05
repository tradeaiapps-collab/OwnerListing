-- Admin-managed Facebook / Instagram lead ads connection (the Meta app and Page token the lead webhook uses).
-- Secrets only as sealed text in value_enc (AES-256-GCM, key from INTEGRATION_SETTINGS_KEY or MESSAGING_SETTINGS_KEY, never stored here). Both NULL = not set.
CREATE TABLE meta_lead_setting (
  field       TEXT PRIMARY KEY CHECK (field IN ('appId','appSecret','verifyToken','pageToken')),
  value       TEXT,
  value_enc   TEXT,
  updated_by  UUID NOT NULL REFERENCES app_user(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (value IS NULL OR value_enc IS NULL),
  CHECK (field = 'appId' OR value IS NULL)
);

-- The result of the last "Test connection" (one row). Cleared whenever a setting changes, so "Connected" never describes old keys.
CREATE TABLE meta_lead_test (
  id          SMALLINT PRIMARY KEY CHECK (id = 1),
  tested_at   TIMESTAMPTZ NOT NULL,
  tested_by   UUID NOT NULL REFERENCES app_user(id),
  ok          BOOLEAN NOT NULL,
  message     TEXT NOT NULL CHECK (char_length(message) <= 300),
  page_name   TEXT CHECK (page_name IS NULL OR char_length(page_name) <= 200),
  page_id     TEXT CHECK (page_id IS NULL OR char_length(page_id) <= 64),
  app_checked BOOLEAN NOT NULL DEFAULT false
);
