-- Agent licence records. Publishing by an agent requires a verified licence for the listing's state.
-- Verification is a human (Compliance) action; the application must never mark a licence verified on its own.

CREATE TABLE agent_licence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_user(id),
  jurisdiction CHAR(3) NOT NULL CHECK (jurisdiction IN ('NSW','VIC','QLD','WA','SA','TAS','ACT','NT')),
  licence_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','expired','revoked')),
  verified_by UUID REFERENCES app_user(id),
  verified_at TIMESTAMPTZ,
  expires_at DATE,
  UNIQUE (user_id, jurisdiction),
  CHECK (status <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);
