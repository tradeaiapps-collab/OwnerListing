ALTER TABLE app_user ADD COLUMN staff_role TEXT
  CHECK (staff_role IN ('super_admin','compliance','accountant','support','technical','reporting'));

CREATE TABLE terms_version (
  version TEXT PRIMARY KEY,
  includes_ai_learning_clause BOOLEAN NOT NULL,
  text_reference TEXT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE terms_acceptance (
  user_id UUID NOT NULL REFERENCES app_user(id),
  version TEXT NOT NULL REFERENCES terms_version(version),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, version)
);

-- Every override: who, what, why, and who approved. Insert only.
CREATE TABLE override_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID NOT NULL REFERENCES app_user(id),
  approver_id UUID REFERENCES app_user(id),
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) >= 10),
  before_state JSONB,
  after_state JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER override_log_append_only
  BEFORE UPDATE OR DELETE ON override_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
