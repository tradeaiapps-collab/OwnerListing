-- Contractor operations: when a job happens, how the contractor gets in, who is there, tenant notice, alert preferences, complaints.
-- Nothing here deletes a row. Access details are sealed in the application (AES-256-GCM) before they reach this table.

-- One visit per job. The owner or the contractor proposes a time; the other side confirms it.
CREATE TABLE job_visit (
  assignment_id UUID PRIMARY KEY REFERENCES job_assignment(id),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','confirmed')),
  proposed_by UUID NOT NULL REFERENCES app_user(id),
  attendees TEXT[] NOT NULL DEFAULT '{}' CHECK (attendees <@ ARRAY['owner','agent','tenant']::text[]),
  reminder_sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '12 hours')
);
CREATE INDEX job_visit_starts_idx ON job_visit (starts_at);

-- How the contractor gets in. `sealed_details` holds the lockbox code or key location; it is only shown to the accepted contractor.
CREATE TABLE job_access (
  assignment_id UUID PRIMARY KEY REFERENCES job_assignment(id),
  method TEXT NOT NULL CHECK (method IN ('owner_present','agent_present','tenant_present','key_handover','lockbox','open_site')),
  sealed_details TEXT CHECK (sealed_details IS NULL OR char_length(sealed_details) <= 2000),
  updated_by UUID NOT NULL REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Entry notice to a tenant, who is not a user. Email only. Insert-only log; the address is kept so staff can answer a complaint.
CREATE TABLE job_tenant_notice (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES job_assignment(id),
  tenant_name TEXT NOT NULL CHECK (char_length(tenant_name) BETWEEN 1 AND 100),
  tenant_email TEXT NOT NULL CHECK (char_length(tenant_email) <= 254),
  window_starts_at TIMESTAMPTZ NOT NULL,
  window_ends_at TIMESTAMPTZ NOT NULL,
  sent_by UUID NOT NULL REFERENCES app_user(id),
  status TEXT NOT NULL CHECK (status IN ('sent','failed')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (window_ends_at > window_starts_at)
);
CREATE INDEX job_tenant_notice_assignment_idx ON job_tenant_notice (assignment_id, sent_at);

-- A contractor's own choice of how job alerts reach them. In-app is always on.
CREATE TABLE contractor_job_pref (
  user_id UUID PRIMARY KEY REFERENCES app_user(id),
  email BOOLEAN NOT NULL DEFAULT true,
  sms BOOLEAN NOT NULL DEFAULT false,
  reminder_hours INTEGER NOT NULL DEFAULT 24 CHECK (reminder_hours IN (0, 2, 24, 48)),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An owner's report of a problem with a job. Staff read these; the dispute and suspension workflow builds on it.
CREATE TABLE contractor_complaint (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES job_assignment(id),
  reported_by UUID NOT NULL REFERENCES app_user(id),
  kind TEXT NOT NULL CHECK (kind IN ('no_show','poor_work','late','conduct','other')),
  details TEXT NOT NULL CHECK (char_length(details) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX contractor_complaint_assignment_idx ON contractor_complaint (assignment_id);
