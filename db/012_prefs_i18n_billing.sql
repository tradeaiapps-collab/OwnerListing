CREATE TABLE user_preference (
  user_id UUID PRIMARY KEY REFERENCES app_user(id),
  locale TEXT NOT NULL DEFAULT 'en-AU',
  time_zone TEXT NOT NULL DEFAULT 'Australia/Sydney',   -- IANA name; all timestamps are stored in UTC
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A language is enabled only after a person has reviewed its catalogue.
CREATE TABLE enabled_locale (
  code TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  reviewed_by UUID REFERENCES app_user(id),
  reviewed_at TIMESTAMPTZ
);

-- Chat originals are permanent and never changed. Translations are separate rows.
ALTER TABLE chat_message ADD COLUMN language TEXT;
CREATE TABLE chat_message_translation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES chat_message(id),
  locale TEXT NOT NULL,
  text TEXT NOT NULL,
  machine_translated BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER chat_translation_append_only
  BEFORE UPDATE OR DELETE ON chat_message_translation
  FOR EACH ROW EXECUTE FUNCTION reject_chat_mutation();

-- Billing. Card numbers are never stored: customers pay on the provider's hosted page.
CREATE TABLE invoice (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES app_user(id),
  subscription_id UUID REFERENCES subscription(id),
  amount_ex_gst_cents BIGINT NOT NULL CHECK (amount_ex_gst_cents >= 0),
  gst_cents BIGINT NOT NULL CHECK (gst_cents >= 0),
  total_cents BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
  provider TEXT,
  provider_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  CHECK (total_cents = amount_ex_gst_cents + gst_cents)
);

-- The provider's event id is the primary key, so a repeated webhook cannot be applied twice.
CREATE TABLE payment_event (
  event_id TEXT PRIMARY KEY,
  invoice_id UUID NOT NULL REFERENCES invoice(id),
  provider TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','failed')),
  amount_cents BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
