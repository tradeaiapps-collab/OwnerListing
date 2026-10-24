-- Queue for alerts that need another try: a failed send (retried with backoff) or a buyer over the hourly limit (deferred).
-- Unlike alert_delivery (insert-only log of every attempt) this table is a work queue, so its rows change state.
CREATE TABLE alert_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_user_id   UUID NOT NULL REFERENCES app_user(id),
  channel         TEXT NOT NULL CHECK (channel IN ('email','sms')),
  listing_id      UUID NOT NULL,
  saved_search_id UUID,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','dead','dropped')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One queued alert per buyer, channel and listing, matching alert_delivery_one_sent_idx.
  UNIQUE (buyer_user_id, channel, listing_id)
);
CREATE INDEX alert_outbox_due_idx ON alert_outbox(next_attempt_at) WHERE status = 'pending';
