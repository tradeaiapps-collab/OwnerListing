-- Document room: view log. One row each time an investor opens a project document in the in-site viewer (staff and the owner are not logged).
-- Insert only. The project owner reads it as a per-investor summary; investors are told on the page that the owner can see that they opened a document.
CREATE TABLE investment_project_document_view (
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES investment_project_document(id),
  project_id UUID NOT NULL REFERENCES investment_project(id),
  viewer_id UUID NOT NULL REFERENCES app_user(id),
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX investment_project_document_view_project_idx ON investment_project_document_view (project_id, viewed_at DESC);
CREATE INDEX investment_project_document_view_doc_idx ON investment_project_document_view (document_id, viewer_id, viewed_at DESC);
CREATE TRIGGER investment_project_document_view_append_only
  BEFORE UPDATE OR DELETE ON investment_project_document_view
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
