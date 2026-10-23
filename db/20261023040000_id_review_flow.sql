-- One waiting submission per person, so the review queue cannot be flooded.
CREATE UNIQUE INDEX id_submission_one_pending_idx ON id_submission(user_id) WHERE status = 'pending';

-- Each reviewer decision with the checklist they ticked. Insert only.
CREATE TABLE id_review_decision (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES id_submission(id),
  staff_user_id UUID NOT NULL REFERENCES app_user(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('approve','reject','needs_more')),
  checklist JSONB NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER id_review_decision_append_only
  BEFORE UPDATE OR DELETE ON id_review_decision
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
