-- Listing templates: reusable description and standard fields (no photos, price, title or address). Personal, or shared with an agent team.
CREATE TABLE listing_template (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by UUID NOT NULL REFERENCES app_user(id),
  team_id UUID REFERENCES agent_team(id),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 300),
  category TEXT NOT NULL CHECK (category IN ('house','apartment','villa','vacation_rental')),
  furnishing TEXT CHECK (furnishing IN ('furnished','unfurnished')),
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX listing_template_owner ON listing_template (created_by, updated_at DESC);
CREATE INDEX listing_template_team ON listing_template (team_id, updated_at DESC) WHERE team_id IS NOT NULL;
