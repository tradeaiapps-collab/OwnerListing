-- Elena on investor projects: owner approval of her drafted answers.
-- A project can run in "approve_first" (default: Elena drafts, the owner approves, edits or discards, and only then does the investor see
-- the answer) or "instant" (the earlier behaviour: quoted answers are shown at once). Declines and escalations never needed approval.
ALTER TABLE elena_project_question ADD COLUMN needs_approval BOOLEAN NOT NULL DEFAULT false;

-- One decision per drafted answer, insert-only. 'edited' carries the owner's own wording; 'approved' releases Elena's quoted draft as written.
CREATE TABLE elena_project_answer_review (
  question_id UUID PRIMARY KEY REFERENCES elena_project_question(id),
  owner_user_id UUID NOT NULL REFERENCES app_user(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved','edited','discarded')),
  body TEXT CHECK (body IS NULL OR length(body) BETWEEN 2 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((decision = 'edited') = (body IS NOT NULL))
);
CREATE TRIGGER elena_project_answer_review_append_only BEFORE UPDATE OR DELETE ON elena_project_answer_review FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE TABLE elena_project_answer_setting (
  project_id UUID PRIMARY KEY REFERENCES investment_project(id),
  answer_mode TEXT NOT NULL DEFAULT 'approve_first' CHECK (answer_mode IN ('approve_first','instant')),
  updated_by UUID NOT NULL REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
