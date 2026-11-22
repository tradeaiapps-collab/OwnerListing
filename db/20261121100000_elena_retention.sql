-- Retention for applicant data kept by Elena's rental and enquiry features. Off until staff switch it on.
-- Purging scrubs personal fields in place and stamps purged_at; rows, ids and the audit trail stay. Chat and Elena message records are never touched.
CREATE TABLE elena_retention_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled BOOLEAN NOT NULL DEFAULT false,
  retention_days INTEGER NOT NULL DEFAULT 365 CHECK (retention_days BETWEEN 90 AND 3650),
  last_run_at TIMESTAMPTZ,
  updated_by UUID REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO elena_retention_settings (singleton) VALUES (true);

ALTER TABLE rental_application ADD COLUMN purged_at TIMESTAMPTZ;
ALTER TABLE elena_enquiry_action ADD COLUMN purged_at TIMESTAMPTZ;

-- One row per purge run: counts only, never the data removed. Insert only.
CREATE TABLE elena_retention_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger TEXT NOT NULL CHECK (trigger IN ('staff','schedule')),
  staff_id UUID REFERENCES app_user(id),
  retention_days INTEGER NOT NULL,
  applications_scrubbed INTEGER NOT NULL,
  enquiry_actions_scrubbed INTEGER NOT NULL,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER elena_retention_run_append_only BEFORE UPDATE OR DELETE ON elena_retention_run FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE INDEX rental_application_purge_idx ON rental_application (updated_at) WHERE purged_at IS NULL;
CREATE INDEX elena_enquiry_action_purge_idx ON elena_enquiry_action (created_at) WHERE purged_at IS NULL;
