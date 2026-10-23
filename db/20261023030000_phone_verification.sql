-- One-time codes for mobile verification. Only a keyed hash of the code is stored.
CREATE TABLE phone_challenge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_user(id),
  phone_e164 TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ
);
CREATE INDEX phone_challenge_user_idx ON phone_challenge(user_id, created_at DESC);
CREATE INDEX phone_challenge_phone_idx ON phone_challenge(phone_e164, created_at DESC);

-- One verified number per account, so a number cannot back several fake buyers.
ALTER TABLE buyer_verification ADD COLUMN phone_e164 TEXT UNIQUE;
