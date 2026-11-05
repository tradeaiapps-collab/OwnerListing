-- Agent teams: an agency groups licensed agents, assigns tasks and splits commission between agent and team.
-- Joining needs the agent's own acceptance. Commission rate is a team-level assumption (no per-listing commission data exists).
CREATE TABLE agent_team (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  created_by UUID NOT NULL REFERENCES app_user(id),
  commission_rate_bps INT NOT NULL DEFAULT 200 CHECK (commission_rate_bps BETWEEN 0 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

CREATE TABLE agent_team_member (
  team_id UUID NOT NULL REFERENCES agent_team(id),
  user_id UUID NOT NULL REFERENCES app_user(id),
  role TEXT NOT NULL CHECK (role IN ('principal','manager','agent')),
  status TEXT NOT NULL CHECK (status IN ('invited','active','removed')),
  agent_share_bps INT NOT NULL DEFAULT 5000 CHECK (agent_share_bps BETWEEN 0 AND 10000),
  invited_by UUID REFERENCES app_user(id),
  invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  joined_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  PRIMARY KEY (team_id, user_id)
);
-- An agent belongs to at most one team at a time, and a team has one principal.
CREATE UNIQUE INDEX one_active_team_per_agent ON agent_team_member (user_id) WHERE status = 'active';
CREATE UNIQUE INDEX one_principal_per_team ON agent_team_member (team_id) WHERE role = 'principal' AND status = 'active';

CREATE TABLE agent_team_task (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES agent_team(id),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  listing_id UUID REFERENCES property_listing(id),
  assignee_user_id UUID NOT NULL REFERENCES app_user(id),
  created_by UUID NOT NULL REFERENCES app_user(id),
  due_on DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at TIMESTAMPTZ
);
CREATE INDEX agent_team_task_idx ON agent_team_task (team_id, status, due_on);
