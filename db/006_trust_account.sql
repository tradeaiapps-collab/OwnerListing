-- Solicitor firms and trust accounts. The platform never holds funds; deposits go to the firm's trust account.
CREATE TABLE law_firm (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  jurisdiction CHAR(3) NOT NULL CHECK (jurisdiction IN ('NSW','VIC','QLD','WA','SA','TAS','ACT','NT')),
  tier TEXT NOT NULL DEFAULT 'unregistered' CHECK (tier IN ('registered','unregistered')),
  registry_email TEXT
);

CREATE TABLE trust_account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES law_firm(id),
  account_name TEXT NOT NULL,
  bsb CHAR(6) NOT NULL,
  account_number_encrypted BYTEA NOT NULL,      -- encrypted at rest; never logged
  details_fingerprint TEXT NOT NULL,            -- hash of name, BSB, number; any change alters it
  last_human_approved_fingerprint TEXT,
  approved_by UUID REFERENCES app_user(id),
  approved_at TIMESTAMPTZ
);

-- One row per job check, so every re-verification is kept.
CREATE TABLE trust_account_check (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  trust_account_id UUID NOT NULL REFERENCES trust_account(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved','awaiting_human_approval','needs_more_evidence','flagged_for_admin','rejected')),
  evidence JSONB NOT NULL,
  reasons JSONB NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
