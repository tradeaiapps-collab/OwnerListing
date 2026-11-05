-- Saved and scheduled staff reports. A definition is what to report (grouping, measures, period); a schedule re-runs it and emails the
-- owner; a run is a stored snapshot of one result, kept for history and comparison. Runs are visible to the report's owner only.
CREATE TABLE saved_report (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES app_user(id),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  definition JSONB NOT NULL,
  shared BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX saved_report_owner_idx ON saved_report(owner_user_id, created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX saved_report_shared_idx ON saved_report(created_at DESC) WHERE archived_at IS NULL AND shared;

CREATE TABLE report_schedule (
  report_id UUID PRIMARY KEY REFERENCES saved_report(id),
  frequency TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  weekday SMALLINT NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 1 AND 7),
  day_of_month SMALLINT NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 28),
  hour SMALLINT NOT NULL DEFAULT 7 CHECK (hour BETWEEN 0 AND 23),
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_run_at TIMESTAMPTZ NOT NULL,
  last_run_at TIMESTAMPTZ,
  last_status TEXT CHECK (last_status IN ('sent','not_configured','failed','owner_no_access'))
);
CREATE INDEX report_schedule_due_idx ON report_schedule(next_run_at) WHERE enabled;

CREATE TABLE report_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL REFERENCES saved_report(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('manual','schedule')),
  run_by UUID REFERENCES app_user(id),
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  result JSONB NOT NULL,
  insights JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX report_run_report_idx ON report_run(report_id, created_at DESC);
