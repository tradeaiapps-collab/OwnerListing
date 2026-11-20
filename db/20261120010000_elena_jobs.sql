-- Elena handles contractor jobs (photographer, inspector, others) for owners who switch it on per listing.
-- Settings are per listing; one elena_job tracks one job_assignment; elena_job_message is the permanent, visible log.
CREATE TABLE elena_job_settings (
  listing_id UUID PRIMARY KEY REFERENCES property_listing(id),
  handle_jobs BOOLEAN NOT NULL DEFAULT false,
  -- Elena may answer routine email replies herself. Off unless the owner turns it on.
  auto_reply BOOLEAN NOT NULL DEFAULT false,
  -- New contractor photos are added to the gallery as hidden until the owner shows them.
  hide_new_files BOOLEAN NOT NULL DEFAULT false,
  updated_by UUID NOT NULL REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE elena_job (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL UNIQUE REFERENCES job_assignment(id),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  owner_user_id UUID NOT NULL REFERENCES app_user(id),
  contractor_user_id UUID NOT NULL REFERENCES app_user(id),
  kind TEXT NOT NULL,
  -- Shown in every message so an email reply can be matched to the job. Package 1's JOB- number can replace it later.
  contact_ref TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','negotiating','scheduled','awaiting_delivery','delivered','needs_owner','stopped')),
  proposed_at TIMESTAMPTZ,
  proposed_by TEXT CHECK (proposed_by IN ('owner','contractor')),
  appointment_at TIMESTAMPTZ,
  rounds INT NOT NULL DEFAULT 0,
  reminders INT NOT NULL DEFAULT 0,
  next_action_at TIMESTAMPTZ,
  files_pulled INT NOT NULL DEFAULT 0,
  needs_owner_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX elena_job_due_idx ON elena_job (next_action_at) WHERE state NOT IN ('delivered','stopped','needs_owner');
CREATE INDEX elena_job_listing_idx ON elena_job (listing_id);

-- Everything Elena sent or received on a job. Insert-only: it is the record the owner can always read.
CREATE TABLE elena_job_message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES elena_job(id),
  direction TEXT NOT NULL CHECK (direction IN ('out','in')),
  party TEXT NOT NULL CHECK (party IN ('owner','contractor')),
  kind TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  status TEXT NOT NULL CHECK (status IN ('sent','blocked','rate_limited','failed','received','ignored')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX elena_job_message_job_idx ON elena_job_message (job_id, created_at);
CREATE INDEX elena_job_message_rate_idx ON elena_job_message (job_id, party, created_at) WHERE direction = 'out' AND status = 'sent';
CREATE TRIGGER elena_job_message_append_only BEFORE UPDATE OR DELETE ON elena_job_message FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
