-- Council and water rates stated by the seller for a sale listing. One row per listing, each charge optional.
-- Amounts are whole AUD cents for the period printed on the rates notice (quarter or year). Information from the seller only.
CREATE TABLE listing_rates (
  listing_id UUID PRIMARY KEY REFERENCES property_listing(id),
  council_cents BIGINT CHECK (council_cents IS NULL OR council_cents BETWEEN 1 AND 100000000),
  council_period TEXT CHECK (council_period IS NULL OR council_period IN ('quarter', 'year')),
  water_cents BIGINT CHECK (water_cents IS NULL OR water_cents BETWEEN 1 AND 100000000),
  water_period TEXT CHECK (water_period IS NULL OR water_period IN ('quarter', 'year')),
  water_usage_billed_separately BOOLEAN,
  as_at DATE,
  updated_by UUID NOT NULL REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK ((council_cents IS NULL) = (council_period IS NULL)),
  CHECK ((water_cents IS NULL) = (water_period IS NULL)),
  CHECK ((council_cents IS NULL AND water_cents IS NULL) OR as_at IS NOT NULL)
);
