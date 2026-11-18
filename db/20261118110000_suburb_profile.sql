-- Suburb data feed: one row per state and suburb, loaded by staff from a CSV the platform is licensed to use.
-- metrics holds only the fixed figures in src/domain/suburb-data.ts (money in cents). Every row names its source and as-at date.
CREATE TABLE suburb_profile (
  state TEXT NOT NULL CHECK (state IN ('NSW','VIC','QLD','WA','SA','TAS','ACT','NT')),
  suburb_key TEXT NOT NULL CHECK (char_length(suburb_key) BETWEEN 1 AND 80),
  suburb TEXT NOT NULL CHECK (char_length(suburb) BETWEEN 1 AND 80),
  postcode CHAR(4) CHECK (postcode IS NULL OR postcode ~ '^[0-9]{4}$'),
  metrics JSONB NOT NULL CHECK (jsonb_typeof(metrics) = 'object' AND metrics <> '{}'::jsonb),
  source TEXT NOT NULL CHECK (char_length(source) BETWEEN 3 AND 120),
  as_at DATE NOT NULL,
  updated_by UUID NOT NULL REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (state, suburb_key)
);
CREATE INDEX suburb_profile_postcode_idx ON suburb_profile (postcode);

-- One row per import (who, when, source, how many suburbs), so a bad load can be traced.
CREATE TABLE suburb_import (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  as_at DATE NOT NULL,
  suburbs INTEGER NOT NULL CHECK (suburbs > 0),
  created_suburbs INTEGER NOT NULL CHECK (created_suburbs >= 0),
  imported_by UUID NOT NULL REFERENCES app_user(id),
  imported_at TIMESTAMPTZ NOT NULL
);
