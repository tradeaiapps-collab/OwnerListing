-- Lead ads: leads captured from Facebook/Instagram Lead Ads and Google lead form extensions, the staff inbox, spend for cost per lead.
-- Leads are people who filled in an ad form; they are not accounts. Conversion to enquiry/offer is derived by matching the lead's email to an
-- account, never stored, so it cannot go stale.

CREATE TABLE ad_lead_source (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('meta','google')),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 2 AND 80),
  -- Meta: the Facebook Page id the form belongs to. Google: the customer (account) id. Matches an incoming lead to this source.
  account_ref TEXT NOT NULL CHECK (char_length(account_ref) BETWEEN 1 AND 64),
  -- SHA-256 of the key Google sends as google_key in each lead. Shown once when issued, never stored. Null for Meta (signed with the app secret).
  webhook_key_hash CHAR(64),
  default_agent_id UUID REFERENCES app_user(id),
  followup_mode TEXT NOT NULL DEFAULT 'off' CHECK (followup_mode IN ('off','contact','matches')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (provider <> 'google' OR webhook_key_hash IS NOT NULL)
);
CREATE UNIQUE INDEX ad_lead_source_account_idx ON ad_lead_source (provider, account_ref);

CREATE TABLE ad_lead (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES ad_lead_source(id),
  -- The provider's own lead id, so a retried webhook never makes a second lead.
  external_id TEXT NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
  name TEXT CHECK (name IS NULL OR char_length(name) <= 120),
  email CITEXT CHECK (email IS NULL OR char_length(email) <= 254),
  phone TEXT CHECK (phone IS NULL OR char_length(phone) <= 20),
  interest TEXT CHECK (interest IN ('buying','selling','renting')),
  suburb TEXT CHECK (suburb IS NULL OR char_length(suburb) <= 80),
  postcode TEXT CHECK (postcode IS NULL OR postcode ~ '^[0-9]{4}$'),
  campaign_ref TEXT CHECK (campaign_ref IS NULL OR char_length(campaign_ref) <= 120),
  ad_ref TEXT CHECK (ad_ref IS NULL OR char_length(ad_ref) <= 120),
  -- Provider test leads (Meta/Google "send test") are kept to prove the connection works but are left out of every figure and never emailed.
  is_test BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','qualified','lost')),
  lost_reason TEXT CHECK (lost_reason IS NULL OR char_length(lost_reason) <= 300),
  assigned_agent_id UUID REFERENCES app_user(id),
  assigned_at TIMESTAMPTZ,
  followup_status TEXT NOT NULL DEFAULT 'none' CHECK (followup_status IN ('none','sent','failed','skipped')),
  followup_sent_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_id),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX ad_lead_inbox_idx ON ad_lead (received_at DESC);
CREATE INDEX ad_lead_status_idx ON ad_lead (status, received_at DESC);
CREATE INDEX ad_lead_agent_idx ON ad_lead (assigned_agent_id) WHERE assigned_agent_id IS NOT NULL;
CREATE INDEX ad_lead_email_idx ON ad_lead (email) WHERE email IS NOT NULL;

-- What was spent on a source each day, in AUD cents, entered by staff from the ad account. Cost per lead = spend / leads over the same days.
CREATE TABLE ad_lead_spend (
  source_id UUID NOT NULL REFERENCES ad_lead_source(id),
  day DATE NOT NULL,
  spend_cents BIGINT NOT NULL CHECK (spend_cents >= 0 AND spend_cents <= 100000000),
  recorded_by UUID NOT NULL REFERENCES app_user(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, day)
);
