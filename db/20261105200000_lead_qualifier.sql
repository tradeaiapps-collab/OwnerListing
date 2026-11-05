-- Elena as lead qualifier: leads, their messages, routing, notes, follow-ups and the learned scoring config.
-- A lead is a prospect (not necessarily a registered user). Contact details are only shared with the assigned agent.
CREATE TABLE lead (
  id UUID PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('chat','sms','email')),
  -- chat: sha256 of the session token; sms: E.164 number; email: lower-case address.
  external_id TEXT NOT NULL CHECK (char_length(external_id) BETWEEN 3 AND 254),
  user_id UUID REFERENCES app_user(id),
  slots JSONB NOT NULL DEFAULT '{}',
  asked JSONB NOT NULL DEFAULT '{}',
  skipped JSONB NOT NULL DEFAULT '[]',
  last_asked TEXT,
  turns INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','complete','handoff_requested','opted_out','abandoned')),
  score INT NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  tier TEXT NOT NULL DEFAULT 'cold' CHECK (tier IN ('hot','warm','cold')),
  score_detail JSONB NOT NULL DEFAULT '[]',
  config_version INT NOT NULL DEFAULT 0,
  consent_contact BOOLEAN NOT NULL DEFAULT false,
  origin_hash TEXT,
  routed_at TIMESTAMPTZ,
  abandoned_after TEXT,
  checkins_sent INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One live conversation per channel identity; a closed lead lets the same person start a new one.
CREATE UNIQUE INDEX lead_live_identity_idx ON lead(channel, external_id) WHERE status = 'open';
CREATE INDEX lead_origin_idx ON lead(origin_hash, created_at) WHERE origin_hash IS NOT NULL;
CREATE INDEX lead_status_idx ON lead(status, updated_at);

CREATE TABLE lead_turn (
  id UUID PRIMARY KEY,
  lead_id UUID NOT NULL REFERENCES lead(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  body TEXT NOT NULL CHECK (char_length(body) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lead_turn_lead_idx ON lead_turn(lead_id, created_at);

CREATE TABLE lead_assignment (
  lead_id UUID PRIMARY KEY REFERENCES lead(id) ON DELETE CASCADE,
  agent_user_id UUID NOT NULL REFERENCES app_user(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by TEXT NOT NULL DEFAULT 'elena' CHECK (assigned_by IN ('elena','staff')),
  agent_score INT NOT NULL CHECK (agent_score BETWEEN 0 AND 100),
  reasons JSONB NOT NULL DEFAULT '[]',
  alternatives JSONB NOT NULL DEFAULT '[]',
  sla_due_at TIMESTAMPTZ NOT NULL,
  first_contact_at TIMESTAMPTZ,
  result TEXT CHECK (result IN ('converted','lost','unresponsive')),
  result_at TIMESTAMPTZ,
  result_note TEXT CHECK (result_note IS NULL OR char_length(result_note) <= 500)
);
CREATE INDEX lead_assignment_agent_idx ON lead_assignment(agent_user_id, result);

CREATE TABLE lead_note (
  id UUID PRIMARY KEY,
  lead_id UUID NOT NULL REFERENCES lead(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL CHECK (author_type IN ('elena','agent','staff')),
  author_user_id UUID REFERENCES app_user(id),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lead_note_lead_idx ON lead_note(lead_id, created_at);

CREATE TABLE lead_followup (
  id UUID PRIMARY KEY,
  lead_id UUID NOT NULL REFERENCES lead(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('elena_checkin','agent_sla')),
  attempt INT NOT NULL DEFAULT 1,
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','skipped','failed')),
  handled_at TIMESTAMPTZ
);
CREATE INDEX lead_followup_due_idx ON lead_followup(due_at) WHERE status = 'pending';

-- Versions of the learned scoring weights and question order. Active = the highest version with activated_at set.
CREATE TABLE lead_qualifier_config (
  version INT PRIMARY KEY,
  weights JSONB NOT NULL,
  question_order JSONB NOT NULL,
  sample_size INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES app_user(id),
  activated_at TIMESTAMPTZ,
  activated_by UUID REFERENCES app_user(id)
);
