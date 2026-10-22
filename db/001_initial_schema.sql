-- PostgreSQL starter schema. Review and apply only through migrations in a controlled environment.
-- Event history is append-only by application contract; production DB permissions/triggers
-- must additionally prevent UPDATE/DELETE for audit and ledger event tables.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE app_user (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT UNIQUE,
  display_name TEXT NOT NULL,
  user_type TEXT NOT NULL CHECK (user_type IN ('owner','agent','vendor','admin','project_owner','investor')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE property_listing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES app_user(id),
  jurisdiction CHAR(3) NOT NULL CHECK (jurisdiction IN ('NSW','VIC','QLD','WA','SA','TAS','ACT','NT')),
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('sale','rent')),
  use_class TEXT NOT NULL CHECK (use_class IN ('residential','commercial')),
  property_type TEXT NOT NULL CHECK (property_type IN ('house','unit','townhouse','land','office','retail','industrial','warehouse','hospitality','other')),
  title TEXT NOT NULL,
  address_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','published','withdrawn')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE listing_disclosure (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  jurisdiction CHAR(3) NOT NULL CHECK (jurisdiction IN ('NSW','VIC','QLD','WA','SA','TAS','ACT','NT')),
  disclosure_key TEXT NOT NULL,
  satisfied BOOLEAN NOT NULL DEFAULT false,
  evidence_reference TEXT,
  verified_by UUID REFERENCES app_user(id),
  verified_at TIMESTAMPTZ,
  UNIQUE (listing_id, disclosure_key)
);

CREATE TABLE audit_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','service','system')),
  actor_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_event_aggregate_idx ON audit_event(aggregate_type, aggregate_id, occurred_at);
CREATE INDEX listing_search_idx ON property_listing(jurisdiction, status, transaction_type, created_at DESC);

-- Investment tables are intentionally not created in this first slice; Gate G4 required.
-- Money movement/ledger tables are intentionally deferred until the ledger ADR is reviewed.
