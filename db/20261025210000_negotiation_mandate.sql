-- Negotiation mandate (House Listing Spec 019_negotiation). One row per version; a save is a new version, never an
-- edit. The floor price is sealed with AES-256-GCM (MANDATE_FLOOR_KEY) before it reaches the database.
CREATE TABLE negotiation_mandate (
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  floor_price_sealed TEXT NOT NULL,
  target_price_cents BIGINT NOT NULL CHECK (target_price_cents > 0),
  max_counter_rounds SMALLINT NOT NULL CHECK (max_counter_rounds BETWEEN 0 AND 10),
  max_concession_bps_per_round INTEGER NOT NULL CHECK (max_concession_bps_per_round BETWEEN 0 AND 1000),
  approved_conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  settlement_min_days SMALLINT NOT NULL CHECK (settlement_min_days BETWEEN 1 AND 365),
  settlement_max_days SMALLINT NOT NULL CHECK (settlement_max_days BETWEEN 1 AND 365),
  -- Auto mode is off until Gate G3; the app refuses it too.
  auto_mode_enabled BOOLEAN NOT NULL DEFAULT false CHECK (NOT auto_mode_enabled),
  quiet_hours JSONB NOT NULL DEFAULT '{"from":"20:00","to":"08:00"}'::jsonb,
  set_by UUID NOT NULL REFERENCES app_user(id),
  set_by_kind TEXT NOT NULL CHECK (set_by_kind IN ('owner','agent')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, version),
  CHECK (settlement_min_days <= settlement_max_days)
);

CREATE OR REPLACE FUNCTION reject_mandate_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'negotiation_mandate is append-only: save a new version';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER negotiation_mandate_append_only BEFORE UPDATE OR DELETE ON negotiation_mandate
  FOR EACH ROW EXECUTE FUNCTION reject_mandate_mutation();
