-- Seller market insights. The cache holds worked-out figures per area so repeat views do not re-read every sale; a row is a stored result
-- with an expiry, never a source of truth (the sales are). Pricing preferences keep the goal a seller chose and the advice they were shown.
CREATE TABLE market_insights_cache (
  area_key TEXT NOT NULL CHECK (char_length(area_key) BETWEEN 1 AND 200),
  metric_type TEXT NOT NULL CHECK (metric_type IN ('comparable_sales','price_trend','days_on_market','price_days')),
  data JSONB NOT NULL,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (area_key, metric_type)
);
CREATE INDEX market_insights_cache_expiry_idx ON market_insights_cache(expires_at);

CREATE TABLE seller_pricing_preferences (
  listing_id UUID PRIMARY KEY REFERENCES property_listing(id),
  seller_goal TEXT NOT NULL CHECK (seller_goal IN ('fast_sale','max_price','balanced')),
  recommended_price_cents BIGINT CHECK (recommended_price_cents > 0),
  recommended_price_rationale TEXT CHECK (char_length(recommended_price_rationale) <= 1000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
