-- Scheduler secrets managed from the admin console. Only a SHA-256 hash is stored (never the secret itself);
-- the plain secret is shown once, when it is generated. The environment variable stays as a fallback when no row has a secret.
CREATE TABLE cron_secret_setting (
  job TEXT PRIMARY KEY CHECK (job IN ('automations','staff_automation')),
  secret_hash TEXT CHECK (secret_hash IS NULL OR secret_hash ~ '^[0-9a-f]{64}$'),
  secret_last4 TEXT CHECK (secret_last4 IS NULL OR length(secret_last4) = 4),
  -- Off pauses the job: the endpoint answers 503 to every caller. It never opens the endpoint up.
  enabled BOOLEAN NOT NULL DEFAULT true,
  rotated_at TIMESTAMPTZ,
  last_called_at TIMESTAMPTZ,
  updated_by UUID REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
