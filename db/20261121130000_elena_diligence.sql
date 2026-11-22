-- Elena's due-diligence summary per investor project. The developer (project owner) approves a draft before investors can read it.
-- One draft at a time (Elena can rewrite it while it is a draft); a published summary can never change or be deleted, and a new
-- summary is a new row, so investors always see the latest published one and the history stays.
CREATE TABLE elena_project_diligence (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES investment_project(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  -- Elena's findings exactly as stored: only quoted, masked sentences plus fixed wording (DiligenceSummary).
  summary JSONB NOT NULL,
  -- The developer's own words next to the findings, shown as theirs.
  developer_note TEXT NOT NULL DEFAULT '' CHECK (length(developer_note) <= 1000),
  -- "documentId:maskId" of each document read, to tell investors when the documents have changed since.
  source_keys TEXT[] NOT NULL DEFAULT '{}',
  engine_version INT NOT NULL,
  created_by_user UUID NOT NULL REFERENCES app_user(id),
  approved_by UUID REFERENCES app_user(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'published') = (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE UNIQUE INDEX elena_project_diligence_one_draft ON elena_project_diligence (project_id) WHERE status = 'draft';
CREATE INDEX elena_project_diligence_project_idx ON elena_project_diligence (project_id, created_at DESC);
CREATE OR REPLACE FUNCTION elena_project_diligence_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'due-diligence summaries are never deleted'; END IF;
  IF OLD.status = 'published' THEN RAISE EXCEPTION 'a published due-diligence summary cannot be changed'; END IF;
  IF NEW.project_id <> OLD.project_id OR NEW.created_by_user <> OLD.created_by_user THEN RAISE EXCEPTION 'summary ownership cannot change'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER elena_project_diligence_guard BEFORE UPDATE OR DELETE ON elena_project_diligence FOR EACH ROW EXECUTE FUNCTION elena_project_diligence_guard();
