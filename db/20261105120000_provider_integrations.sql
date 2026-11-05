-- Outside-provider plumbing (push: FCM/APNs; property data: MLS, Zillow). Skeleton only: no provider is implemented yet.
--   provider_credentials  which owner/agent or team has connected which provider. The secret is stored sealed (AES-256-GCM, key
--                         PROVIDER_CREDENTIAL_KEY), never in clear text; rows are revoked, not deleted.
--   provider_sync_logs    one row per sync run: when it ran, how many records, success or error.
--   provider_events       raw verified webhook deliveries, kept for audit. Insert-only apart from the processing outcome.
CREATE TABLE provider_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('fcm','apns','mls','zillow')),
  owner_user_id UUID REFERENCES app_user(id),
  team_id UUID REFERENCES agency_team(id),
  external_account_id TEXT CHECK (external_account_id IS NULL OR char_length(external_account_id) BETWEEN 1 AND 200),
  secret_sealed TEXT CHECK (secret_sealed IS NULL OR char_length(secret_sealed) <= 8000),
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','revoked','error')),
  last_error TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Belongs to exactly one agent/owner or one team.
  CONSTRAINT provider_credentials_one_holder CHECK ((owner_user_id IS NULL) <> (team_id IS NULL))
);
CREATE UNIQUE INDEX provider_credentials_user_live_idx ON provider_credentials(provider, owner_user_id) WHERE owner_user_id IS NOT NULL AND status <> 'revoked';
CREATE UNIQUE INDEX provider_credentials_team_live_idx ON provider_credentials(provider, team_id) WHERE team_id IS NOT NULL AND status <> 'revoked';

CREATE TABLE provider_sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('fcm','apns','mls','zillow')),
  credential_id UUID REFERENCES provider_credentials(id),
  kind TEXT NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 60),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','error')),
  records_seen INT NOT NULL DEFAULT 0 CHECK (records_seen >= 0),
  records_changed INT NOT NULL DEFAULT 0 CHECK (records_changed >= 0),
  error_code TEXT CHECK (error_code IS NULL OR char_length(error_code) <= 60),
  error_message TEXT CHECK (error_message IS NULL OR char_length(error_message) <= 500),
  correlation_id TEXT CHECK (correlation_id IS NULL OR char_length(correlation_id) <= 100),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX provider_sync_logs_recent_idx ON provider_sync_logs(provider, started_at DESC);

CREATE TABLE provider_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('fcm','apns','mls','zillow')),
  -- The provider's own event id (or a hash of the body when it sends none): a repeat delivery is recognised and ignored.
  event_id TEXT NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 200),
  event_type TEXT NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 100),
  payload JSONB NOT NULL,
  body_sha256 TEXT NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  process_status TEXT NOT NULL DEFAULT 'received' CHECK (process_status IN ('received','processed','ignored','failed')),
  process_error TEXT CHECK (process_error IS NULL OR char_length(process_error) <= 500),
  processed_at TIMESTAMPTZ,
  UNIQUE (provider, event_id)
);
CREATE INDEX provider_events_recent_idx ON provider_events(provider, received_at DESC);

-- Raw events are an audit record: never deleted, and only the processing outcome may change.
CREATE FUNCTION provider_events_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'provider_events is an append-only record'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.body_sha256 IS DISTINCT FROM OLD.body_sha256 OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'provider_events is an append-only record (only the processing outcome can change)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER provider_events_guard BEFORE UPDATE OR DELETE ON provider_events FOR EACH ROW EXECUTE FUNCTION provider_events_guard();
