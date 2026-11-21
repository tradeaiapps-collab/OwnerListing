-- Weekly investor update digest: one optional email a week with new owner-approved project updates and answered questions.
-- One row per investor. No row means "on" (opt-out model); enabled = false is an opt-out. last_sent_at is the claim that stops a second send in the same week.
CREATE TABLE investor_digest_setting (
  user_id UUID PRIMARY KEY REFERENCES app_user(id),
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
