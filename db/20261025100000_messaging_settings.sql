-- Admin-managed email/SMS settings and the log of every outbound message.

-- One row per setting. Plain values in value; secrets (SMS auth token, SMTP password) only as sealed text in value_enc
-- (AES-256-GCM, key from MESSAGING_SETTINGS_KEY, never stored here). Both NULL = not set.
CREATE TABLE messaging_setting (
  field       TEXT PRIMARY KEY CHECK (field IN (
    'sms.provider','sms.accountSid','sms.authToken','sms.apiKeySid','sms.sender',
    'email.host','email.port','email.user','email.password','email.from')),
  value       TEXT,
  value_enc   TEXT,
  updated_by  UUID NOT NULL REFERENCES app_user(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (value IS NULL OR value_enc IS NULL),
  CHECK (field NOT IN ('sms.authToken','email.password') OR value IS NULL)
);

-- Every outbound email/SMS attempt. Insert-only. No message body, address or phone number: the recipient is a keyed hash.
CREATE TABLE messaging_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         TEXT NOT NULL CHECK (channel IN ('email','sms')),
  template        TEXT NOT NULL CHECK (template ~ '^[a-z_]{1,40}$'),
  recipient_hash  TEXT,
  status          TEXT NOT NULL CHECK (status IN ('sent','failed','not_configured')),
  provider_ref    TEXT,
  error_code      TEXT CHECK (error_code ~ '^[a-z_]{1,40}$'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messaging_outbox_created_idx ON messaging_outbox(created_at);

CREATE OR REPLACE FUNCTION reject_messaging_outbox_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'messaging_outbox is insert-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER messaging_outbox_no_update
  BEFORE UPDATE OR DELETE ON messaging_outbox
  FOR EACH ROW EXECUTE FUNCTION reject_messaging_outbox_mutation();
