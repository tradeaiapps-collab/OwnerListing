-- Council and water rates per address: where a figure came from, and an address-keyed table staff fill by CSV (or a provider later).
-- listing_rates.source_kind: owner (typed by the seller), staff (entered by staff), import (taken from address_rates), provider (a live feed).
ALTER TABLE listing_rates
  ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'owner' CHECK (source_kind IN ('owner', 'staff', 'import', 'provider')),
  ADD COLUMN source_name TEXT CHECK (source_name IS NULL OR char_length(source_name) BETWEEN 3 AND 120);

-- One row per normalised address and state. Amounts are whole AUD cents for the stated period, same as listing_rates.
CREATE TABLE address_rates (
  state CHAR(3) NOT NULL CHECK (state IN ('NSW','VIC','QLD','WA','SA','TAS','ACT','NT')),
  address_key TEXT NOT NULL CHECK (char_length(address_key) BETWEEN 5 AND 200),
  address TEXT NOT NULL,
  council_cents BIGINT CHECK (council_cents IS NULL OR council_cents BETWEEN 1 AND 100000000),
  council_period TEXT CHECK (council_period IS NULL OR council_period IN ('quarter', 'year')),
  water_cents BIGINT CHECK (water_cents IS NULL OR water_cents BETWEEN 1 AND 100000000),
  water_period TEXT CHECK (water_period IS NULL OR water_period IN ('quarter', 'year')),
  water_usage_billed_separately BOOLEAN,
  source TEXT NOT NULL CHECK (char_length(source) BETWEEN 3 AND 120),
  as_at DATE NOT NULL,
  updated_by UUID NOT NULL REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (state, address_key),
  CHECK ((council_cents IS NULL) = (council_period IS NULL)),
  CHECK ((water_cents IS NULL) = (water_period IS NULL)),
  CHECK (council_cents IS NOT NULL OR water_cents IS NOT NULL)
);
