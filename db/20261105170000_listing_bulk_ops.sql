-- Staff bulk operations on listings: soft delete, sale/rent outcome, campaign tags and a job table that records each bulk run.
ALTER TABLE property_listing
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN outcome TEXT CHECK (outcome IS NULL OR outcome IN ('sold','rented'));
CREATE INDEX property_listing_deleted_idx ON property_listing (deleted_at) WHERE deleted_at IS NOT NULL;

-- Free-form campaign / category tags set by staff (lowercase, 2-40 characters).
CREATE TABLE listing_tag (
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  tag TEXT NOT NULL CHECK (tag ~ '^[a-z0-9][a-z0-9 _-]{1,39}$'),
  added_by UUID NOT NULL REFERENCES app_user(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, tag)
);
CREATE INDEX listing_tag_tag_idx ON listing_tag (tag);

-- One row per bulk run. The run is resumable: `processed` counts the listing ids already handled, in order.
CREATE TABLE listing_bulk_job (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by UUID NOT NULL REFERENCES app_user(id),
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason TEXT NOT NULL,
  listing_ids UUID[] NOT NULL CHECK (cardinality(listing_ids) BETWEEN 1 AND 500),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  processed INTEGER NOT NULL DEFAULT 0,
  succeeded INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  -- Listings that were skipped or failed: [{ "id", "outcome": "skipped"|"failed", "message" }].
  problems JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX listing_bulk_job_open_idx ON listing_bulk_job (status, heartbeat_at) WHERE status IN ('queued','running');
