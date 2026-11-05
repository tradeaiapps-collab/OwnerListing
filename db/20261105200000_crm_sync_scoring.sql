-- CRM depth: (1) status changes sent back to the agency CRM, (2) staff-tunable lead scoring with agent overrides.

-- Outbound: an optional signed webhook per feed connection. The secret signs each delivery (same scheme as the public API webhooks).
ALTER TABLE feed_connection
  ADD COLUMN outbound_url TEXT CHECK (outbound_url IS NULL OR (outbound_url LIKE 'https://%' AND char_length(outbound_url) <= 500)),
  ADD COLUMN outbound_secret TEXT,
  ADD COLUMN outbound_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN outbound_enabled_at TIMESTAMPTZ,
  ADD COLUMN outbound_failures INTEGER NOT NULL DEFAULT 0 CHECK (outbound_failures >= 0),
  ADD CONSTRAINT feed_connection_outbound_ready CHECK (NOT outbound_enabled OR (outbound_url IS NOT NULL AND outbound_secret IS NOT NULL AND outbound_enabled_at IS NOT NULL));

-- Last status told to the CRM for each listing. A change from this is what gets sent.
CREATE TABLE crm_sync_state (
  connection_id UUID NOT NULL REFERENCES feed_connection(id) ON DELETE CASCADE,
  listing_id    UUID NOT NULL REFERENCES property_listing(id),
  status        TEXT NOT NULL CHECK (status IN ('active','sold','rented','delisted')),
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, listing_id)
);

-- Queue of events for the CRM, with retry state. One row per listing change, so a re-run never sends it twice.
CREATE TABLE crm_outbound_delivery (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id   UUID NOT NULL REFERENCES feed_connection(id) ON DELETE CASCADE,
  listing_id      UUID NOT NULL REFERENCES property_listing(id),
  event_type      TEXT NOT NULL CHECK (event_type IN ('listing.sold','listing.rented','listing.delisted','listing.reactivated')),
  occurred_at     TIMESTAMPTZ NOT NULL,
  payload         JSONB NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status     INTEGER,
  last_error      TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 200),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ,
  UNIQUE (connection_id, listing_id, event_type, occurred_at)
);
CREATE INDEX crm_outbound_due_idx ON crm_outbound_delivery (next_attempt_at) WHERE state = 'pending';
CREATE INDEX crm_outbound_connection_idx ON crm_outbound_delivery (connection_id, created_at DESC);

-- Lead scoring rules set by staff: one row. Weights are whole percentages adding to 100; warm sits below hot.
CREATE TABLE lead_scoring_setting (
  id            SMALLINT PRIMARY KEY CHECK (id = 1),
  hot_min       SMALLINT NOT NULL CHECK (hot_min BETWEEN 2 AND 100),
  warm_min      SMALLINT NOT NULL CHECK (warm_min BETWEEN 1 AND 99),
  w_engagement  SMALLINT NOT NULL CHECK (w_engagement BETWEEN 0 AND 100),
  w_fit         SMALLINT NOT NULL CHECK (w_fit BETWEEN 0 AND 100),
  w_follow_up   SMALLINT NOT NULL CHECK (w_follow_up BETWEEN 0 AND 100),
  updated_by    UUID REFERENCES app_user(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (warm_min < hot_min),
  CHECK (w_engagement + w_fit + w_follow_up = 100)
);
INSERT INTO lead_scoring_setting (id, hot_min, warm_min, w_engagement, w_fit, w_follow_up) VALUES (1, 70, 40, 60, 25, 15);

-- An agent's own score for one lead, with the reason. Private to that agent, replaces the automatic score until removed.
CREATE TABLE agent_lead_override (
  agent_user_id UUID NOT NULL REFERENCES app_user(id),
  enquiry_id    UUID NOT NULL REFERENCES enquiry(id),
  score         SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
  reason        TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 300),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_user_id, enquiry_id)
);
