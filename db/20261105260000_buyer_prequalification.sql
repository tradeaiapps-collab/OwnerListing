-- Buyer mortgage pre-approval letters. The PDF bytes live in object storage (document_url is the private storage key, never served to sellers).
-- Status 'expired' is also derived on read from expires_at, so no job is needed yet (automatic expiry checks come later).
CREATE TABLE buyer_prequalifications (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id              UUID NOT NULL REFERENCES app_user(id),
  listing_id            UUID REFERENCES property_listing(id),
  document_url          TEXT NOT NULL CHECK (document_url ~ '^prequal/[A-Za-z0-9_-]{1,64}/[A-Za-z0-9_-]{1,64}$'),
  sha256                CHAR(64) NOT NULL,
  size_bytes            INTEGER NOT NULL CHECK (size_bytes > 0),
  status                TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','verified','resubmit_requested','expired')),
  approved_amount_cents BIGINT CHECK (approved_amount_cents IS NULL OR approved_amount_cents > 0),
  interest_rate         NUMERIC(5,3) CHECK (interest_rate IS NULL OR (interest_rate > 0 AND interest_rate < 30)),
  loan_term_years       SMALLINT CHECK (loan_term_years IS NULL OR loan_term_years BETWEEN 1 AND 40),
  conditions            JSONB NOT NULL DEFAULT '[]'::jsonb,
  share_with_sellers    BOOLEAN NOT NULL DEFAULT TRUE,
  verified_by           UUID REFERENCES app_user(id),
  verified_at           TIMESTAMPTZ,
  review_note           TEXT CHECK (review_note IS NULL OR length(review_note) <= 1000),
  expires_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prequal_verified_has_facts CHECK (status <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL AND approved_amount_cents IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE INDEX buyer_prequal_buyer_idx ON buyer_prequalifications (buyer_id, created_at DESC);
CREATE INDEX buyer_prequal_status_idx ON buyer_prequalifications (status, created_at DESC);
CREATE INDEX buyer_prequal_listing_idx ON buyer_prequalifications (listing_id) WHERE listing_id IS NOT NULL;

-- Elena's reading. Insert only: staff confirming the figures adds a newer row; the latest row is the current one.
CREATE TABLE prequalification_summaries (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prequalification_id  UUID NOT NULL REFERENCES buyer_prequalifications(id),
  confidence_level     TEXT NOT NULL CHECK (confidence_level IN ('high','medium','low')),
  extracted_data       JSONB NOT NULL,
  elena_summary        TEXT NOT NULL CHECK (length(elena_summary) <= 1000),
  red_flags            JSONB NOT NULL DEFAULT '[]'::jsonb,
  engine               TEXT NOT NULL CHECK (engine ~ '^[a-z0-9.-]{1,40}$'),
  source               TEXT NOT NULL CHECK (source IN ('elena','staff')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX prequal_summary_idx ON prequalification_summaries (prequalification_id, created_at DESC);
CREATE TRIGGER prequal_summaries_append_only
  BEFORE UPDATE OR DELETE ON prequalification_summaries
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
