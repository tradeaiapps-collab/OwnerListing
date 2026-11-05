-- Agent reports: saved report definitions, an optional email schedule per report, and a snapshot of each run (totals only) for history.
CREATE TABLE agent_report (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_user_id UUID NOT NULL REFERENCES app_user(id),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  definition JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_report_agent_idx ON agent_report (agent_user_id, created_at DESC);

CREATE TABLE agent_report_schedule (
  report_id UUID PRIMARY KEY REFERENCES agent_report(id) ON DELETE CASCADE,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  next_run_at TIMESTAMPTZ NOT NULL,
  last_run_at TIMESTAMPTZ,
  last_status TEXT CHECK (last_status IN ('sent','not_sent','skipped')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_report_schedule_due_idx ON agent_report_schedule (next_run_at);

CREATE TABLE agent_report_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL REFERENCES agent_report(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual','scheduled')),
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  totals JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_report_run_idx ON agent_report_run (report_id, created_at DESC);
