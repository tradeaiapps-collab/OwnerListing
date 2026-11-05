-- Property data feeds: connections to outside sources (agency CRM REAXML feeds, the Domain API) that import listings,
-- sold prices and leases. Imported facts land in property / property_event with source 'licensed_third_party'.
-- Nothing here publishes a listing: CRM listings are staged for the agent, who can start a draft from one.

CREATE TABLE feed_connection (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('reaxml','domain')),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 2 AND 80),
  -- The agent whose CRM this is. Required for CRM feeds; null for platform-wide market data.
  agent_user_id UUID REFERENCES app_user(id),
  territory JSONB NOT NULL DEFAULT '{"states":[],"postcodes":[],"suburbs":[]}'::jsonb,
  schedule TEXT NOT NULL DEFAULT 'daily' CHECK (schedule IN ('daily','weekly','manual')),
  -- CRM pull address (https). Credentials never go here: pushes use the token below, provider keys live in the environment.
  source_url TEXT CHECK (source_url IS NULL OR source_url LIKE 'https://%'),
  -- SHA-256 of the push token a CRM sends to POST /api/feeds/reaxml/{id}. The token itself is shown once and never stored.
  push_token_hash CHAR(64),
  -- Sold prices from this connection count in comparables and valuations only with a recorded licence that allows it.
  comparables_licensed BOOLEAN NOT NULL DEFAULT false,
  licence_terms TEXT CHECK (licence_terms IS NULL OR char_length(licence_terms) <= 1000),
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (provider <> 'reaxml' OR agent_user_id IS NOT NULL),
  CHECK (NOT comparables_licensed OR char_length(coalesce(licence_terms, '')) >= 10),
  -- An agency's own CRM is agent-supplied, not independent market evidence.
  CHECK (provider <> 'reaxml' OR NOT comparables_licensed)
);
CREATE INDEX feed_connection_due_idx ON feed_connection (next_run_at) WHERE enabled AND schedule <> 'manual';
CREATE INDEX feed_connection_agent_idx ON feed_connection (agent_user_id) WHERE agent_user_id IS NOT NULL;

CREATE TABLE feed_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES feed_connection(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule','staff','push')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  fetched INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,
  -- Short, key-free message for staff. Never a provider response body.
  error TEXT CHECK (error IS NULL OR char_length(error) <= 500),
  rejects JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX feed_run_connection_idx ON feed_run (connection_id, started_at DESC);

-- Latest copy of each outside record, for change detection and the agent's staged imports.
CREATE TABLE feed_record (
  connection_id UUID NOT NULL REFERENCES feed_connection(id),
  external_id TEXT NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
  content_hash CHAR(64) NOT NULL,
  property_id UUID NOT NULL REFERENCES property(id),
  status TEXT NOT NULL CHECK (status IN ('active','sold','leased','withdrawn')),
  item JSONB NOT NULL,
  -- The draft an agent started from this record, if any. One draft per record.
  draft_listing_id UUID REFERENCES property_listing(id),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, external_id)
);

-- Which connection an imported event came from, so its licence decides whether comparables may use it.
ALTER TABLE property_event ADD COLUMN feed_connection_id UUID REFERENCES feed_connection(id);
CREATE UNIQUE INDEX property_event_feed_uniq ON property_event (feed_connection_id, property_id, event_type, occurred_at)
  WHERE feed_connection_id IS NOT NULL;
-- Address matching for imports (street addresses only).
CREATE INDEX property_address_match_idx ON property (lower(address_text), state);
