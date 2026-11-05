-- Automation: workflows (trigger, filter, steps), the runs they start, and an insert-only activity log.
-- A workflow is archived, never deleted. Runs and log rows are a permanent record of what was sent.

CREATE TABLE automation_workflow (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES app_user(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  trigger_key TEXT NOT NULL CHECK (trigger_key IN ('new_lead','property_listed','offer_received','inspection_complete')),
  definition JSONB NOT NULL,
  -- Optional: only fire for this listing. NULL means every listing the owner manages.
  listing_id UUID REFERENCES property_listing(id),
  active BOOLEAN NOT NULL DEFAULT false,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX automation_workflow_trigger_idx ON automation_workflow(trigger_key) WHERE active AND archived_at IS NULL;
CREATE INDEX automation_workflow_owner_idx ON automation_workflow(owner_user_id, created_at DESC);

CREATE TABLE automation_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES automation_workflow(id),
  -- The event that started it (enquiry, listing, offer or inspection id). One run per workflow per event.
  subject_key TEXT NOT NULL,
  contact_user_id UUID REFERENCES app_user(id),
  listing_id UUID REFERENCES property_listing(id),
  -- Snapshot of the facts at trigger time. Listing facts and a first name only.
  facts JSONB NOT NULL DEFAULT '{}'::jsonb,
  definition JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','waiting','completed','stopped','failed')),
  step_index INTEGER NOT NULL DEFAULT 0,
  wake_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (workflow_id, subject_key)
);
CREATE INDEX automation_run_due_idx ON automation_run(wake_at) WHERE status IN ('running','waiting');

CREATE TABLE automation_log (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES automation_run(id),
  workflow_id UUID NOT NULL REFERENCES automation_workflow(id),
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,
  step_id TEXT,
  detail TEXT NOT NULL DEFAULT '' CHECK (length(detail) <= 300),
  -- For send rows: pending, then sent / skipped / failed. Updated once, by the sender.
  outcome TEXT CHECK (outcome IN ('pending','sent','skipped','failed'))
);
CREATE INDEX automation_log_workflow_idx ON automation_log(workflow_id, id DESC);
CREATE INDEX automation_log_run_idx ON automation_log(run_id, id);

-- The log is append-only apart from a send row's outcome moving off 'pending'.
CREATE FUNCTION automation_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'automation_log is insert-only'; END IF;
  IF OLD.outcome = 'pending' AND NEW.outcome IN ('sent','skipped','failed')
     AND NEW.run_id = OLD.run_id AND NEW.kind = OLD.kind AND NEW.detail = OLD.detail AND NEW.at = OLD.at THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'automation_log is insert-only';
END $$;
CREATE TRIGGER automation_log_no_change BEFORE UPDATE OR DELETE ON automation_log
  FOR EACH ROW EXECUTE FUNCTION automation_log_guard();
