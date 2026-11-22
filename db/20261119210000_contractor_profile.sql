-- Where a photographer or building inspector works. The contractor fills this in themselves; Elena uses it to send the first invitation
-- for a new listing in their area. The contractor still has to accept, and the owner can always invite someone else.
CREATE TABLE contractor_profile (
  user_id UUID NOT NULL REFERENCES app_user(id),
  kind TEXT NOT NULL CHECK (kind IN ('photographer','inspector')),
  accepting_new BOOLEAN NOT NULL DEFAULT true,
  service_postcodes TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(service_postcodes) <= 200),
  service_suburbs TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(service_suburbs) <= 200),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);
CREATE INDEX contractor_profile_kind_idx ON contractor_profile (kind) WHERE accepting_new;
