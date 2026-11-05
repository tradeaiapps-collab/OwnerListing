-- Listing performance for sellers. One row per listing per UTC day, worked out from the raw records (listing_view, enquiry, formal_offer),
-- so a row is a cache and can always be rebuilt. The cache table holds the daily market comparison and the day/time heatmap.
-- The outcome table keeps how a listing actually ended (first offer, acceptance, totals) so benchmarks use real results.
CREATE TABLE listing_performance_daily_snapshot (
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  snapshot_date DATE NOT NULL,
  views INT NOT NULL DEFAULT 0 CHECK (views >= 0),
  inquiries INT NOT NULL DEFAULT 0 CHECK (inquiries >= 0),
  offers INT NOT NULL DEFAULT 0 CHECK (offers >= 0),
  -- Days from listing creation to the first offer; set only on the day that offer arrived.
  time_to_offer_days INT CHECK (time_to_offer_days IS NULL OR time_to_offer_days >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, snapshot_date)
);
CREATE INDEX listing_performance_snapshot_date_idx ON listing_performance_daily_snapshot (snapshot_date);

CREATE TABLE listing_performance_cache (
  listing_id UUID PRIMARY KEY REFERENCES property_listing(id),
  market JSONB NOT NULL,
  heatmap JSONB NOT NULL,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE listing_performance_outcome (
  listing_id UUID PRIMARY KEY REFERENCES property_listing(id),
  accepted_price_cents BIGINT CHECK (accepted_price_cents IS NULL OR accepted_price_cents > 0),
  days_to_first_offer INT CHECK (days_to_first_offer IS NULL OR days_to_first_offer >= 0),
  days_to_acceptance INT CHECK (days_to_acceptance IS NULL OR days_to_acceptance >= 0),
  total_views INT NOT NULL DEFAULT 0,
  total_inquiries INT NOT NULL DEFAULT 0,
  total_offers INT NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
