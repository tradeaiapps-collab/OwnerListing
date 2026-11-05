-- AI tour videos (Hedra). Two ways to pay: an agency team spends its monthly video budget (model 'team'), or a buyer pays once
-- through Stripe Checkout (model 'buyer'). One row per generation; jobs are claimed and retried by a DB-polled queue.
CREATE TABLE listing_video (
  id UUID PRIMARY KEY,
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  model TEXT NOT NULL CHECK (model IN ('team', 'buyer')),
  requested_by UUID NOT NULL REFERENCES app_user(id),
  team_id UUID REFERENCES agency_team(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  provider_job_id TEXT,
  storage_key TEXT UNIQUE,
  content_type TEXT,
  cost_cents INT NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline_at TIMESTAMPTZ NOT NULL,
  error TEXT NOT NULL DEFAULT '' CHECK (char_length(error) <= 500),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  CHECK (model <> 'team' OR team_id IS NOT NULL)
);
CREATE INDEX listing_video_listing_idx ON listing_video (listing_id, requested_at DESC);
CREATE INDEX listing_video_queue_idx ON listing_video (next_attempt_at) WHERE status IN ('queued', 'processing') AND archived_at IS NULL;
-- At most one video in flight or kept per listing and model, so a double click or two buyers never pay Hedra twice.
CREATE UNIQUE INDEX listing_video_one_live ON listing_video (listing_id, model) WHERE archived_at IS NULL AND status <> 'failed';

CREATE TABLE video_purchase (
  id UUID PRIMARY KEY,
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  buyer_id UUID NOT NULL REFERENCES app_user(id),
  video_id UUID REFERENCES listing_video(id),
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'aud' CHECK (currency = 'aud'),
  checkout_session_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX video_purchase_buyer_idx ON video_purchase (buyer_id, listing_id);

-- A team's monthly allowance for videos. Spend is derived from the ledger below, never stored, so it cannot drift.
CREATE TABLE team_video_budget (
  team_id UUID PRIMARY KEY REFERENCES agency_team(id),
  monthly_budget_cents INT NOT NULL CHECK (monthly_budget_cents BETWEEN 0 AND 100000000),
  set_by UUID NOT NULL REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Invoice items: a charge when a team video is queued, a negative refund row when it ends failed. Insert only.
CREATE TABLE team_video_ledger (
  id UUID PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES agency_team(id),
  video_id UUID NOT NULL REFERENCES listing_video(id),
  kind TEXT NOT NULL CHECK (kind IN ('charge', 'refund')),
  amount_cents INT NOT NULL CHECK ((kind = 'charge' AND amount_cents > 0) OR (kind = 'refund' AND amount_cents < 0)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (video_id, kind)
);
CREATE INDEX team_video_ledger_month_idx ON team_video_ledger (team_id, created_at);
CREATE TRIGGER team_video_ledger_append_only
  BEFORE UPDATE OR DELETE ON team_video_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- Stripe event ids already handled (webhooks repeat).
CREATE TABLE video_webhook_event (event_id TEXT PRIMARY KEY, received_at TIMESTAMPTZ NOT NULL DEFAULT now());
