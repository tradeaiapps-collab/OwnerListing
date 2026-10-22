-- Broker credentials and per-buyer nominations for the professional AI.
CREATE TABLE broker_credential (
  user_id UUID PRIMARY KEY REFERENCES app_user(id),
  credit_licence_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','suspended','revoked')),
  verified_by UUID REFERENCES app_user(id),
  verified_at TIMESTAMPTZ,
  CHECK (status <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);

CREATE TABLE broker_nomination (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_user_id UUID NOT NULL REFERENCES app_user(id),
  broker_user_id UUID NOT NULL REFERENCES broker_credential(user_id),
  buyer_consent_to_share_financials BOOLEAN NOT NULL DEFAULT false,
  nominated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX one_active_nomination_per_pair
  ON broker_nomination(buyer_user_id, broker_user_id) WHERE ended_at IS NULL;
