-- One row per agent, area, kind of market shift and month: the dedupe key for Elena's proactive market-shift alerts, so a nightly run
-- cannot tell an agent about the same shift twice in a month. Counts and area names only; no buyer, owner or price data.
CREATE TABLE market_shift_alert (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_user_id UUID NOT NULL REFERENCES app_user(id),
  area_key TEXT NOT NULL CHECK (char_length(area_key) BETWEEN 1 AND 200),
  shift_kind TEXT NOT NULL CHECK (shift_kind IN ('prices_up','prices_down','heating','cooling','slower_sales','faster_sales','demand_up','demand_down')),
  period_month TEXT NOT NULL CHECK (period_month ~ '^\d{4}-\d{2}$'),
  severity TEXT NOT NULL CHECK (severity IN ('notable','major')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_user_id, area_key, shift_kind, period_month)
);
CREATE INDEX market_shift_alert_created_idx ON market_shift_alert (created_at DESC);
