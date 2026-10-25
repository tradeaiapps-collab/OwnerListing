-- Price guidance (spec 3.2 020_ai_records price_estimate). Advisory, owner and appointed agent only, never public.
-- Insert-only: a new estimate is a new row, so the history of what the owner was shown is kept.
CREATE TABLE price_estimate (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  low_cents BIGINT NOT NULL CHECK (low_cents > 0),
  mid_cents BIGINT NOT NULL,
  high_cents BIGINT NOT NULL,
  confidence NUMERIC(3,2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  comparables JSONB NOT NULL,
  model_version TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (low_cents <= mid_cents AND mid_cents <= high_cents)
);
CREATE INDEX price_estimate_listing_idx ON price_estimate(listing_id, created_at DESC);
CREATE TRIGGER price_estimate_append_only BEFORE UPDATE OR DELETE ON price_estimate
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
