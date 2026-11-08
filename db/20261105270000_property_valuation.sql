-- Property valuation reports for buyers: one global settings row and per-listing overrides. Off until a super admin turns it on.
-- The figures are worked out from comparable sales on request (see market_insights_cache); nothing about a valuation is stored here.
CREATE TABLE valuation_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  min_comps_required INT NOT NULL DEFAULT 8 CHECK (min_comps_required BETWEEN 3 AND 50),
  high_confidence_comps INT NOT NULL DEFAULT 12 CHECK (high_confidence_comps BETWEEN 3 AND 100),
  show_fair_range BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES app_user(id),
  CHECK (high_confidence_comps >= min_comps_required)
);
INSERT INTO valuation_settings (id) VALUES (1);

CREATE TABLE valuation_overrides (
  listing_id UUID PRIMARY KEY REFERENCES property_listing(id),
  enabled BOOLEAN NOT NULL,
  override_reason TEXT NOT NULL CHECK (char_length(override_reason) BETWEEN 2 AND 500),
  set_by UUID REFERENCES app_user(id),
  set_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
