-- Elena on investor projects: investor questions and her answers, owner replies, owner-approved project updates, and who follows a project.
-- Questions and replies are insert-only (the owner can always read the record). A published update can never change or be deleted;
-- a draft can be edited by the owner until they approve it. Follow rows may be removed (unfollow).
CREATE TABLE elena_project_question (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES investment_project(id),
  asker_user_id UUID NOT NULL REFERENCES app_user(id),
  question TEXT NOT NULL CHECK (length(question) BETWEEN 5 AND 500),
  answer TEXT NOT NULL CHECK (length(answer) BETWEEN 1 AND 6000),
  outcome TEXT NOT NULL CHECK (outcome IN ('answered','escalated','declined')),
  reason TEXT,
  -- [{docId, title, page, quote}] exactly as shown to the investor.
  sources JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX elena_project_question_project_idx ON elena_project_question (project_id, created_at DESC);
CREATE INDEX elena_project_question_asker_idx ON elena_project_question (asker_user_id, project_id, created_at DESC);
CREATE TRIGGER elena_project_question_append_only BEFORE UPDATE OR DELETE ON elena_project_question FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE TABLE elena_project_question_reply (
  id UUID PRIMARY KEY,
  question_id UUID NOT NULL REFERENCES elena_project_question(id),
  owner_user_id UUID NOT NULL REFERENCES app_user(id),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 2 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX elena_project_question_reply_idx ON elena_project_question_reply (question_id, created_at);
CREATE TRIGGER elena_project_question_reply_append_only BEFORE UPDATE OR DELETE ON elena_project_question_reply FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE TABLE investment_project_update (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES investment_project(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 20 AND 4000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  source_doc_ids UUID[] NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL CHECK (created_by IN ('elena','owner')),
  created_by_user UUID NOT NULL REFERENCES app_user(id),
  approved_by UUID REFERENCES app_user(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'published') = (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX investment_project_update_project_idx ON investment_project_update (project_id, created_at DESC);
CREATE OR REPLACE FUNCTION investment_project_update_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'project updates are never deleted'; END IF;
  IF OLD.status = 'published' THEN RAISE EXCEPTION 'a published update cannot be changed'; END IF;
  IF NEW.project_id <> OLD.project_id OR NEW.created_by <> OLD.created_by OR NEW.created_by_user <> OLD.created_by_user THEN RAISE EXCEPTION 'update ownership cannot change'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER investment_project_update_guard BEFORE UPDATE OR DELETE ON investment_project_update FOR EACH ROW EXECUTE FUNCTION investment_project_update_guard();

CREATE TABLE investment_project_follow (
  project_id UUID NOT NULL REFERENCES investment_project(id),
  user_id UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX investment_project_follow_user_idx ON investment_project_follow (user_id);
