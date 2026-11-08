-- Investor project documents: plans, approvals, feasibility studies, contracts, reports.
-- Insert only (reject_ledger_mutation). A replacement is a new row whose supersedes_id points at the version it replaces;
-- the current version of a document is the row nothing supersedes. Files are never deletable.
-- visibility: private = owner only; team = owner and reviewing staff; investors = owner, staff and investors who may see the project.
CREATE TABLE investment_project_document (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES investment_project(id),
  kind TEXT NOT NULL CHECK (kind IN ('plan','approval','feasibility','contract','report','other')),
  visibility TEXT NOT NULL CHECK (visibility IN ('private','team','investors')),
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 120),
  uploaded_by UUID NOT NULL REFERENCES app_user(id),
  content_type TEXT NOT NULL CHECK (content_type IN ('application/pdf','image/jpeg','image/png','image/webp')),
  size_bytes INT NOT NULL CHECK (size_bytes BETWEEN 1 AND 50000000),
  sha256 CHAR(64) NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  supersedes_id UUID UNIQUE REFERENCES investment_project_document(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX investment_project_document_project_idx ON investment_project_document (project_id, uploaded_at);
CREATE INDEX investment_project_document_uploader_idx ON investment_project_document (uploaded_by, uploaded_at);
CREATE TRIGGER investment_project_document_append_only
  BEFORE UPDATE OR DELETE ON investment_project_document
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
