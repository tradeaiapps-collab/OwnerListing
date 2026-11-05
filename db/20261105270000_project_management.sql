-- Internal project management: proposal, feasibility, approval, milestones, and links to the features and PRs that deliver a project.
-- Tables are prefixed staff_project (the investor module already uses "project"). Nothing is deleted: a project is a permanent record.

CREATE TABLE staff_project_settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  high_budget_cents BIGINT NOT NULL DEFAULT 5000000 CHECK (high_budget_cents > 0),
  updated_by UUID REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO staff_project_settings (id) VALUES (true);

CREATE TABLE staff_project (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 120),
  description TEXT NOT NULL CHECK (length(description) <= 4000),
  goal TEXT NOT NULL CHECK (length(btrim(goal)) BETWEEN 3 AND 500),
  owner_id UUID NOT NULL REFERENCES app_user(id),
  status TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','rejected','active','on_hold','completed')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  budget_cents BIGINT NOT NULL DEFAULT 0 CHECK (budget_cents >= 0),
  story_points INT NOT NULL CHECK (story_points IN (1,2,3,5,8,13,21)),
  estimated_hours INT NOT NULL CHECK (estimated_hours BETWEEN 1 AND 100000),
  estimated_days INT NOT NULL CHECK (estimated_days BETWEEN 1 AND 3650),
  team_size INT NOT NULL CHECK (team_size BETWEEN 1 AND 200),
  uses_new_tech BOOLEAN NOT NULL DEFAULT false,
  systems_affected INT NOT NULL DEFAULT 1 CHECK (systems_affected BETWEEN 1 AND 50),
  assumptions TEXT NOT NULL DEFAULT '' CHECK (length(assumptions) <= 2000),
  unknowns TEXT NOT NULL DEFAULT '' CHECK (length(unknowns) <= 2000),
  -- { scope_clear, dependencies_identified, resources_available, budget_justified, effort_estimated }: the proposer's answers at submission.
  checklist JSONB NOT NULL CHECK (jsonb_typeof(checklist) = 'object'),
  created_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  approved_by_id UUID REFERENCES app_user(id),
  completed_at TIMESTAMPTZ,
  -- Progress, blockers and escalation. last_progress_at moves on any milestone, feature, PR or note update.
  last_progress_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_reason TEXT CHECK (blocked_reason IS NULL OR length(blocked_reason) BETWEEN 3 AND 500),
  blocked_since TIMESTAMPTZ,
  escalated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date > start_date),
  CHECK ((blocked_reason IS NULL) = (blocked_since IS NULL)),
  CHECK ((status = 'active') <= (approved_at IS NOT NULL))
);
CREATE INDEX staff_project_status_idx ON staff_project(status);
CREATE INDEX staff_project_owner_idx ON staff_project(owner_id);

CREATE TABLE staff_project_members (
  project_id UUID NOT NULL REFERENCES staff_project(id),
  user_id UUID NOT NULL REFERENCES app_user(id),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE staff_project_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES staff_project(id),
  phase TEXT NOT NULL CHECK (phase IN ('planning','design','build','test','ship')),
  description TEXT NOT NULL CHECK (length(btrim(description)) BETWEEN 3 AND 300),
  target_date DATE NOT NULL,
  actual_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX staff_project_milestones_project_idx ON staff_project_milestones(project_id);

CREATE TABLE staff_project_risk_flags (
  project_id UUID NOT NULL REFERENCES staff_project(id),
  risk_type TEXT NOT NULL CHECK (risk_type IN ('tight_timeline','new_tech','high_complexity','high_budget')),
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  description TEXT NOT NULL,
  PRIMARY KEY (project_id, risk_type)
);

CREATE TABLE staff_project_prs (
  project_id UUID NOT NULL REFERENCES staff_project(id),
  pr_number INT NOT NULL CHECK (pr_number > 0),
  pr_title TEXT NOT NULL CHECK (length(btrim(pr_title)) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK (status IN ('draft','open','needs_review','merged','closed')),
  merged_at TIMESTAMPTZ,
  linked_by UUID NOT NULL REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, pr_number),
  CHECK ((status = 'merged') = (merged_at IS NOT NULL))
);
-- A PR belongs to one project.
CREATE UNIQUE INDEX staff_project_prs_number_uniq ON staff_project_prs(pr_number);

CREATE TABLE staff_project_features (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES staff_project(id),
  feature_name TEXT NOT NULL CHECK (length(btrim(feature_name)) BETWEEN 2 AND 160),
  status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','in_progress','merged','pending_approval')),
  pr_number INT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, feature_name)
);

CREATE TABLE staff_project_approvals (
  project_id UUID NOT NULL REFERENCES staff_project(id),
  approver_id UUID NOT NULL REFERENCES app_user(id),
  role TEXT NOT NULL CHECK (role IN ('tech_lead','stakeholder')),
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  comments TEXT NOT NULL CHECK (length(btrim(comments)) BETWEEN 10 AND 1000),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, approver_id)
);

CREATE OR REPLACE FUNCTION reject_staff_project_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'project records are a permanent record';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER staff_project_no_delete BEFORE DELETE ON staff_project FOR EACH ROW EXECUTE FUNCTION reject_staff_project_delete();
CREATE TRIGGER staff_project_approvals_no_delete BEFORE DELETE ON staff_project_approvals FOR EACH ROW EXECUTE FUNCTION reject_staff_project_delete();
CREATE TRIGGER staff_project_milestones_no_delete BEFORE DELETE ON staff_project_milestones FOR EACH ROW EXECUTE FUNCTION reject_staff_project_delete();
CREATE TRIGGER staff_project_prs_no_delete BEFORE DELETE ON staff_project_prs FOR EACH ROW EXECUTE FUNCTION reject_staff_project_delete();
CREATE TRIGGER staff_project_features_no_delete BEFORE DELETE ON staff_project_features FOR EACH ROW EXECUTE FUNCTION reject_staff_project_delete();
