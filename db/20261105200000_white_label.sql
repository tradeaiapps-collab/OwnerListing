-- White-label: an agency team can run the marketplace under its own brand on its own domain.
-- Shared instance, shared database: the tenant only chooses the look (name, tagline, colours, logo, footer text) for requests that
-- arrive on one of its verified domains. Listings, users and money are NOT split by tenant. A tenant starts as 'draft'; platform staff
-- (theme.edit) set it 'active' once they have checked the name and domain, and can 'suspend' it at any time (the site then falls back to the platform brand).
CREATE TABLE white_label_tenant (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      UUID NOT NULL UNIQUE REFERENCES agency_team(id),
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','suspended')),
  -- Full validated ThemeSettings (same shape and checks as the platform theme: hex colours, WCAG contrast, no raw CSS or HTML).
  settings     JSONB NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  -- Latest uploaded logo / favicon (white_label_asset ids); null = none.
  logo_light_id BIGINT,
  favicon_id    BIGINT,
  created_by   UUID NOT NULL REFERENCES app_user(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by  UUID REFERENCES app_user(id),
  reviewed_at  TIMESTAMPTZ
);

CREATE TABLE white_label_asset (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES white_label_tenant(id),
  slot         TEXT NOT NULL CHECK (slot IN ('logo-light','favicon')),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp','image/x-icon')),
  bytes        BYTEA NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 524288),
  sha256       CHAR(64) NOT NULL,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  created_by   UUID NOT NULL REFERENCES app_user(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX white_label_asset_tenant ON white_label_asset (tenant_id, slot);
CREATE TRIGGER white_label_asset_append_only BEFORE UPDATE OR DELETE ON white_label_asset
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- A host name (lower case, no port) pointing at a tenant. Ownership is proven with a DNS TXT record before the host is used.
CREATE TABLE white_label_domain (
  host         TEXT PRIMARY KEY CHECK (host = lower(host) AND host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' AND char_length(host) <= 253),
  tenant_id    UUID NOT NULL REFERENCES white_label_tenant(id),
  verify_token TEXT NOT NULL,
  verified_at  TIMESTAMPTZ,
  created_by   UUID NOT NULL REFERENCES app_user(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX white_label_domain_tenant ON white_label_domain (tenant_id);
