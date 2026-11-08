-- Address masking of investor project documents. Insert only: every save is a new revision, the latest one counts.
-- boxes: [{page, x, y, w, h, source: 'auto'|'manual'}], fractions of the page (0..1, origin top left), pages from 1.
-- An investor sees a document only while its latest revision is confirmed; the original file is never sent to an investor.
CREATE TABLE investment_project_document_mask (
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES investment_project_document(id),
  revision INT NOT NULL CHECK (revision >= 1),
  boxes JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(boxes) = 'array' AND jsonb_array_length(boxes) <= 2000),
  terms TEXT[] NOT NULL DEFAULT '{}',
  page_count INT NOT NULL CHECK (page_count BETWEEN 1 AND 300),
  text_found BOOLEAN NOT NULL,
  confirmed BOOLEAN NOT NULL DEFAULT false,
  actor_id UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, revision)
);
CREATE TRIGGER investment_project_document_mask_append_only
  BEFORE UPDATE OR DELETE ON investment_project_document_mask
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
