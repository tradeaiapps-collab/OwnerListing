-- Agent commission tracking. A record of what an agent is owed on a deal and when it is due; the platform holds no money and
-- pays nobody. Staff mark a payout paid once the owner or solicitor has paid the agent outside the platform.
-- Money is whole cents. Nothing is deleted: a cancelled deal or payout stays as a row, and every change is also an audit_event.
CREATE TABLE commission_deal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_user_id UUID NOT NULL REFERENCES app_user(id),
  listing_id UUID REFERENCES property_listing(id),
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  sale_price_cents BIGINT NOT NULL CHECK (sale_price_cents > 0 AND sale_price_cents <= 100000000000),
  -- Terms are copied onto the deal when it is created, so later rule changes never alter history.
  kind TEXT NOT NULL CHECK (kind IN ('percentage','fixed','tiered')),
  rate_bps INTEGER CHECK (rate_bps BETWEEN 0 AND 10000),
  fixed_cents BIGINT CHECK (fixed_cents >= 0),
  tiers JSONB,
  calculated_cents BIGINT NOT NULL CHECK (calculated_cents >= 0),
  override_cents BIGINT CHECK (override_cents >= 0),
  override_reason TEXT,
  override_by UUID REFERENCES app_user(id),
  override_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'expected' CHECK (status IN ('expected','earned','cancelled')),
  deal_date DATE NOT NULL,
  settlement_date DATE,
  closed_reason TEXT,
  created_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'percentage') = (rate_bps IS NOT NULL)),
  CHECK ((kind = 'fixed') = (fixed_cents IS NOT NULL)),
  CHECK ((kind = 'tiered') = (tiers IS NOT NULL)),
  CHECK ((override_cents IS NULL) = (override_reason IS NULL AND override_by IS NULL AND override_at IS NULL))
);
CREATE INDEX commission_deal_agent_idx ON commission_deal(agent_user_id, deal_date DESC);
CREATE INDEX commission_deal_status_idx ON commission_deal(status, deal_date DESC);

CREATE TABLE commission_payout (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES commission_deal(id),
  agent_user_id UUID NOT NULL REFERENCES app_user(id),
  due_date DATE NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','paid','cancelled')),
  paid_at TIMESTAMPTZ,
  paid_by UUID REFERENCES app_user(id),
  payment_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL AND paid_by IS NOT NULL))
);
CREATE INDEX commission_payout_agent_idx ON commission_payout(agent_user_id, due_date);
CREATE INDEX commission_payout_deal_idx ON commission_payout(deal_id);

CREATE OR REPLACE FUNCTION reject_commission_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are a permanent record', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER commission_deal_no_delete BEFORE DELETE ON commission_deal FOR EACH ROW EXECUTE FUNCTION reject_commission_delete();
CREATE TRIGGER commission_payout_no_delete BEFORE DELETE ON commission_payout FOR EACH ROW EXECUTE FUNCTION reject_commission_delete();
