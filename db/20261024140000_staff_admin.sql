-- Staff admin screens: case resolution record and the second-person step for safety-gate cases,
-- and one row per trust account decision so a second person can be required. Insert only.
ALTER TABLE admin_case
  ADD COLUMN resolution_reason TEXT,
  ADD COLUMN resolved_by UUID REFERENCES app_user(id),
  ADD COLUMN proposed_by UUID REFERENCES app_user(id),
  ADD COLUMN proposed_reason TEXT;

CREATE TABLE trust_account_approval (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id UUID NOT NULL REFERENCES trust_account_check(id),
  staff_user_id UUID NOT NULL REFERENCES app_user(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('approve','reject')),
  reason TEXT NOT NULL CHECK (length(reason) >= 10),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (check_id, staff_user_id)
);
CREATE TRIGGER trust_account_approval_append_only
  BEFORE UPDATE OR DELETE ON trust_account_approval
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
