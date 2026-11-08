-- Agency teams and offices: members with roles, tasks, commission splits and a payout record.
-- The platform never holds or moves money: a commission entry is a record of what is owed, and "paid" is marked by a manager
-- after the agency pays outside the platform. Amounts are fixed once recorded; nothing here is ever deleted.
CREATE TABLE agency_team (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  kind TEXT NOT NULL DEFAULT 'team' CHECK (kind IN ('team','office')),
  -- Default share of each commission that goes to the member, in basis points (7000 = 70%); the rest stays with the agency.
  default_member_bps INT NOT NULL DEFAULT 7000 CHECK (default_member_bps BETWEEN 0 AND 10000),
  created_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agency_team_member (
  team_id UUID NOT NULL REFERENCES agency_team(id),
  user_id UUID NOT NULL REFERENCES app_user(id),
  role TEXT NOT NULL CHECK (role IN ('manager','agent','staff')),
  -- Per-member split; null means the team default.
  member_bps INT CHECK (member_bps BETWEEN 0 AND 10000),
  added_by UUID NOT NULL REFERENCES app_user(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX agency_team_member_user ON agency_team_member (user_id) WHERE removed_at IS NULL;

CREATE TABLE agency_task (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES agency_team(id),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 2 AND 200),
  notes TEXT NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
  assignee_user_id UUID NOT NULL REFERENCES app_user(id),
  listing_id UUID REFERENCES property_listing(id),
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done')),
  created_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX agency_task_team ON agency_task (team_id, status);
CREATE INDEX agency_task_assignee ON agency_task (assignee_user_id, status);

CREATE TABLE agency_commission (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES agency_team(id),
  member_user_id UUID NOT NULL REFERENCES app_user(id),
  listing_id UUID REFERENCES property_listing(id),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 200),
  gross_cents BIGINT NOT NULL CHECK (gross_cents > 0 AND gross_cents <= 100000000000),
  -- The split in force when the entry was recorded. member_cents + office_cents = gross_cents.
  member_bps INT NOT NULL CHECK (member_bps BETWEEN 0 AND 10000),
  member_cents BIGINT NOT NULL CHECK (member_cents >= 0),
  office_cents BIGINT NOT NULL CHECK (office_cents >= 0),
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','approved','paid')),
  payout_reference TEXT NOT NULL DEFAULT '' CHECK (char_length(payout_reference) <= 200),
  recorded_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  CHECK (member_cents + office_cents = gross_cents)
);
CREATE INDEX agency_commission_team ON agency_commission (team_id, status);
CREATE INDEX agency_commission_member ON agency_commission (member_user_id);
