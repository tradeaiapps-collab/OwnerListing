-- Seller listing optimization (Elena): one suggestion per listing per type, with the seller's response, plus one settings row. Off until a super admin turns it on.
-- Suggestions are worked out by rules on request and kept here so the seller can mark them done and staff can see adoption and outcomes.
CREATE TABLE listing_optimization_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  min_photos INT NOT NULL DEFAULT 8 CHECK (min_photos BETWEEN 3 AND 40),
  min_description_words INT NOT NULL DEFAULT 60 CHECK (min_description_words BETWEEN 20 AND 300),
  max_price_cut_percent INT NOT NULL DEFAULT 10 CHECK (max_price_cut_percent BETWEEN 1 AND 20),
  disabled_types TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES app_user(id)
);
INSERT INTO listing_optimization_settings (id) VALUES (1);

CREATE TABLE listing_optimizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  suggestion_type TEXT NOT NULL CHECK (suggestion_type IN
    ('add_photos','photo_gaps','photo_resolution','add_floorplan','photo_captions','expand_description','highlight_features','complete_details','lower_price')),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 1000),
  -- {"viewsPercent":{"low":n,"high":n},"offersPercent":{"low":n,"high":n},"basis":"..."}: a rule-of-thumb estimate, not a measurement.
  estimated_impact JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','implemented','dismissed','outdated')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  implemented_at TIMESTAMPTZ,
  CHECK ((status = 'implemented') = (implemented_at IS NOT NULL)),
  UNIQUE (listing_id, suggestion_type)
);
CREATE INDEX listing_optimizations_status_idx ON listing_optimizations (status, suggestion_type);
