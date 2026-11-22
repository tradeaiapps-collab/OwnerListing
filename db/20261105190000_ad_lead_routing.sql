-- Lead routing: ordered rules that send a new lead to an agent by postcode, suburb, property type or interest, and a record of how each lead was assigned.
-- With no matching rule a lead goes to an agent whose profile covers its area, then to the form's default agent (see src/domain/ad-lead-routing.ts).

ALTER TABLE ad_lead
  ADD COLUMN property_type TEXT CHECK (property_type IS NULL OR char_length(property_type) <= 30),
  ADD COLUMN assignment_method TEXT CHECK (assignment_method IS NULL OR assignment_method IN ('rule','service_area','default','manual')),
  ADD COLUMN assignment_detail TEXT CHECK (assignment_detail IS NULL OR char_length(assignment_detail) <= 200);

-- Leads assigned before this migration came from the form's default agent.
UPDATE ad_lead SET assignment_method = 'default', assignment_detail = 'Form''s default agent' WHERE assigned_agent_id IS NOT NULL AND assignment_method IS NULL;

CREATE TABLE ad_lead_rule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Null applies to every source.
  source_id UUID REFERENCES ad_lead_source(id),
  position INTEGER NOT NULL DEFAULT 100 CHECK (position BETWEEN 1 AND 10000),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 2 AND 80),
  postcodes TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(postcodes) <= 200),
  suburbs TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(suburbs) <= 200),
  property_types TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(property_types) <= 20),
  interests TEXT[] NOT NULL DEFAULT '{}' CHECK (interests <@ ARRAY['buying','selling','renting']::text[]),
  agent_user_ids UUID[] NOT NULL CHECK (cardinality(agent_user_ids) BETWEEN 1 AND 20),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (cardinality(postcodes) + cardinality(suburbs) + cardinality(property_types) + cardinality(interests) > 0)
);
CREATE INDEX ad_lead_rule_order_idx ON ad_lead_rule (position, created_at) WHERE enabled;
