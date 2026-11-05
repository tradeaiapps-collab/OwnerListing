-- Billing system: numbered invoices with due dates and reminders, recurring subscriptions for owners and agents,
-- bank-transfer payments, and payment disputes. Card numbers are still never stored (hosted payment page only).

CREATE SEQUENCE invoice_number_seq START 1001;

ALTER TABLE invoice DROP CONSTRAINT invoice_status_check;
ALTER TABLE invoice ADD CONSTRAINT invoice_status_check CHECK (status IN ('pending','paid','failed','void','refunded'));

ALTER TABLE invoice
  ADD COLUMN invoice_number TEXT NOT NULL DEFAULT ('INV-' || lpad(nextval('invoice_number_seq')::text, 6, '0')),
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('listing_fee','subscription','other')),
  ADD COLUMN description TEXT,
  ADD COLUMN due_at TIMESTAMPTZ,
  ADD COLUMN payment_method TEXT CHECK (payment_method IN ('card','bank_transfer')),
  ADD COLUMN reminders_sent INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN last_reminder_at TIMESTAMPTZ;
ALTER TABLE invoice ADD CONSTRAINT invoice_number_unique UNIQUE (invoice_number);
UPDATE invoice SET kind = 'listing_fee' WHERE listing_id IS NOT NULL;
UPDATE invoice SET due_at = created_at + interval '14 days' WHERE due_at IS NULL AND status = 'pending';
CREATE INDEX invoice_owner_created ON invoice (owner_user_id, created_at DESC);
CREATE INDEX invoice_subscription ON invoice (subscription_id) WHERE subscription_id IS NOT NULL;

-- Subscription plans for owners and agents. Prices (monthly, excl. GST) are set by an admin, so these cannot be bought until priced.
INSERT INTO plan (id, name, max_photos, storage_gb, features) VALUES
  ('owner_plus', 'Owner Plus', 100, 50, '["video","photo_360","ai_description","ai_auto_reply","ai_applicant_report"]'::jsonb),
  ('agent_pro', 'Agent Pro', 100, 100, '["video","photo_360","video_360","ai_description","ai_auto_reply","ai_applicant_report"]'::jsonb),
  ('agent_team', 'Agent Team', 100, 500, '["video","photo_360","video_360","ai_description","ai_auto_reply","ai_applicant_report","contract_drafting"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE subscription DROP CONSTRAINT subscription_status_check;
ALTER TABLE subscription ADD CONSTRAINT subscription_status_check CHECK (status IN ('pending','active','past_due','expired','cancelled'));
ALTER TABLE subscription
  ADD COLUMN billing_interval TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_interval IN ('monthly','yearly')),
  ADD COLUMN cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN cancelled_at TIMESTAMPTZ,
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
-- One live subscription per account.
CREATE UNIQUE INDEX subscription_one_live_per_owner ON subscription (owner_user_id) WHERE status IN ('pending','active','past_due');

-- A customer's dispute about an invoice. Staff resolve it with a written outcome; money is never moved automatically.
CREATE TABLE payment_dispute (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoice(id),
  raised_by UUID NOT NULL REFERENCES app_user(id),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 1000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','rejected')),
  resolution TEXT,
  resolved_by UUID REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CHECK ((status = 'open') = (resolved_at IS NULL))
);
CREATE UNIQUE INDEX payment_dispute_one_open ON payment_dispute (invoice_id) WHERE status = 'open';
CREATE INDEX payment_dispute_status ON payment_dispute (status, created_at DESC);

-- One row per reminder stage actually sent, so a reminder is never sent twice.
CREATE TABLE billing_reminder (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoice(id),
  stage TEXT NOT NULL CHECK (stage IN ('upcoming','due','overdue','final')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, stage)
);
