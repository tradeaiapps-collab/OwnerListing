-- Team payouts: pays an approved commission to a member through a payment provider (Stripe Connect Express).
-- The provider holds the recipient's bank details and does the identity check (KYC); no card or bank numbers are stored here.
-- Rows are never deleted; a failed payout stays as history and the commission can be paid again.
CREATE TABLE payout_account (
  user_id UUID PRIMARY KEY REFERENCES app_user(id),
  provider TEXT NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe')),
  provider_account_id TEXT NOT NULL UNIQUE CHECK (char_length(provider_account_id) BETWEEN 3 AND 100),
  -- pending: onboarding not finished; verified: identity checked and the provider can pay out; restricted: provider paused it.
  kyc_status TEXT NOT NULL DEFAULT 'pending' CHECK (kyc_status IN ('pending','verified','restricted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE team_payout (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_id UUID NOT NULL REFERENCES agency_commission(id),
  team_id UUID NOT NULL REFERENCES agency_team(id),
  member_user_id UUID NOT NULL REFERENCES app_user(id),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'aud' CHECK (currency = 'aud'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','paid','failed')),
  provider_transfer_id TEXT UNIQUE,
  failure_reason TEXT NOT NULL DEFAULT '' CHECK (char_length(failure_reason) <= 300),
  initiated_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);
-- One live payout per commission: it cannot be paid twice.
CREATE UNIQUE INDEX team_payout_one_live ON team_payout (commission_id) WHERE status <> 'failed';
CREATE INDEX team_payout_team ON team_payout (team_id, created_at DESC);
CREATE INDEX team_payout_member ON team_payout (member_user_id);

CREATE TABLE payout_webhook_event (
  event_id TEXT PRIMARY KEY CHECK (char_length(event_id) BETWEEN 3 AND 100),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
