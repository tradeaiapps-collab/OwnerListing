-- Subscription plans. Prices are set by an admin (pricing.manage), exclude GST, and are never edited:
-- a new price is a new row, and the latest effective row applies. A subscription locks its price.
CREATE TABLE plan (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  max_photos INTEGER NOT NULL CHECK (max_photos > 0),
  storage_gb INTEGER NOT NULL CHECK (storage_gb > 0),
  features JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE plan_price (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id TEXT NOT NULL REFERENCES plan(id),
  price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
  set_by UUID NOT NULL REFERENCES app_user(id),
  reason TEXT NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE add_on_price (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature TEXT NOT NULL CHECK (feature IN ('video','photo_360','video_360','ai_description','ai_auto_reply','ai_applicant_report','contract_drafting')),
  price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
  set_by UUID NOT NULL REFERENCES app_user(id),
  reason TEXT NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subscription (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES app_user(id),
  plan_id TEXT NOT NULL REFERENCES plan(id),
  add_ons JSONB NOT NULL DEFAULT '[]'::jsonb,
  price_snapshot_cents BIGINT NOT NULL CHECK (price_snapshot_cents >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','cancelled')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NOT NULL
);
