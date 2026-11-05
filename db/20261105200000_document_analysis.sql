-- Elena document analyst: one row per reading of a stored document. Insert only; a new reading is a new row.
-- The analysis is a derived summary of a file the requester was already allowed to view; it holds no extra personal data.
CREATE TABLE document_analysis (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL REFERENCES property_document(id),
  listing_id      UUID NOT NULL REFERENCES property_listing(id),
  requested_by    UUID NOT NULL REFERENCES app_user(id),
  engine          TEXT NOT NULL CHECK (engine ~ '^[a-z0-9.-]{1,40}$'),
  doc_class       TEXT NOT NULL CHECK (doc_class IN ('inspection','contract','market','email','unknown')),
  rating          TEXT NOT NULL CHECK (rating IN ('red','amber','green')),
  text_sha256     CHAR(64) NOT NULL,
  analysis        JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX document_analysis_doc_idx ON document_analysis (document_id, engine, created_at DESC);
CREATE INDEX document_analysis_user_idx ON document_analysis (requested_by, created_at DESC);

-- Who the owner chose to tell about a reading. Recipients must be able to view the source document; checked again on every read.
CREATE TABLE document_analysis_share (
  analysis_id UUID NOT NULL REFERENCES document_analysis(id),
  user_id     UUID NOT NULL REFERENCES app_user(id),
  shared_by   UUID NOT NULL REFERENCES app_user(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (analysis_id, user_id)
);

CREATE TRIGGER document_analysis_append_only
  BEFORE UPDATE OR DELETE ON document_analysis
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER document_analysis_share_append_only
  BEFORE UPDATE OR DELETE ON document_analysis_share
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
