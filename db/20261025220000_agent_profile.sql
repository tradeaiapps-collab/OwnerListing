-- What an agent offers, used to suggest agents to owners: service areas, expertise and capacity.
-- An agent fills this in themselves. A suggestion never appoints anyone: the owner invites and the agent accepts.
CREATE TABLE agent_profile (
  user_id UUID PRIMARY KEY REFERENCES app_user(id),
  accepting_new BOOLEAN NOT NULL DEFAULT true,
  max_active_listings INT NOT NULL DEFAULT 20 CHECK (max_active_listings BETWEEN 1 AND 500),
  service_postcodes TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(service_postcodes) <= 200),
  service_suburbs TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(service_suburbs) <= 200),
  transaction_types TEXT[] NOT NULL DEFAULT '{}' CHECK (transaction_types <@ ARRAY['sale','rent']::text[]),
  use_classes TEXT[] NOT NULL DEFAULT '{}' CHECK (use_classes <@ ARRAY['residential','commercial']::text[]),
  property_types TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(property_types) <= 20),
  bio TEXT NOT NULL DEFAULT '' CHECK (char_length(bio) <= 1000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
