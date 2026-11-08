-- Listings Elena cleared and published wait here for a staff admin to review. Publishing never waits for this.
CREATE TABLE IF NOT EXISTS listing_moderation_queue (
  listing_id   UUID PRIMARY KEY REFERENCES property_listing(id),
  published_by UUID NOT NULL,
  advice_count INT NOT NULL DEFAULT 0,
  advice       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed')),
  queued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at  TIMESTAMPTZ,
  reviewed_by  UUID
);
CREATE INDEX IF NOT EXISTS listing_moderation_queue_open_idx ON listing_moderation_queue(queued_at) WHERE status = 'open';
