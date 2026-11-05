-- Inspections, document templates, e-signatures and document history for a listing's transaction.
--
-- inspection / inspection_notice: scheduled inspections and walkthroughs, with the confirmation and reminder emails queued for them.
-- inspection_finding: what the inspector found. Insert only (a correction is a new inspection or a new report).
-- generated_document: a document made from a template. Insert only; a change is a new version that points at the one it replaces.
-- signature_request / signature_signer: e-signing of a generated document. A signer's answer is final.
-- document_event: the history of a generated document (created, new version, viewed, sign requested, signed, declined). Insert only.
--
-- Rollback (manual): DROP TABLE document_event, signature_signer, signature_request, generated_document, inspection_notice,
-- inspection_finding, inspection; DROP FUNCTION signature_signer_final(); delete this file's row from schema_migration.

CREATE TABLE inspection (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id        UUID        NOT NULL REFERENCES property_listing(id),
  kind              TEXT        NOT NULL CHECK (kind IN ('building','pest','pool','strata','walkthrough','other')),
  requested_by      UUID        NOT NULL REFERENCES app_user(id),
  inspector_user_id UUID        REFERENCES app_user(id),
  buyer_user_id     UUID        REFERENCES app_user(id),
  scheduled_start   TIMESTAMPTZ NOT NULL,
  duration_minutes  INTEGER     NOT NULL CHECK (duration_minutes BETWEEN 15 AND 480),
  status            TEXT        NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','confirmed','completed','cancelled')),
  access_notes      TEXT        CHECK (char_length(access_notes) <= 500),
  cancel_reason     TEXT        CHECK (char_length(cancel_reason) <= 300),
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inspection_listing_idx ON inspection (listing_id, scheduled_start);
CREATE INDEX inspection_inspector_idx ON inspection (inspector_user_id, scheduled_start) WHERE inspector_user_id IS NOT NULL;
CREATE INDEX inspection_buyer_idx ON inspection (buyer_user_id, scheduled_start) WHERE buyer_user_id IS NOT NULL;

CREATE TABLE inspection_finding (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id UUID        NOT NULL REFERENCES inspection(id),
  severity      TEXT        NOT NULL CHECK (severity IN ('info','minor','major','urgent')),
  area          TEXT        NOT NULL CHECK (char_length(area) BETWEEN 1 AND 80),
  summary       TEXT        NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
  recommendation TEXT       CHECK (char_length(recommendation) <= 500),
  created_by    UUID        NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inspection_finding_idx ON inspection_finding (inspection_id);
CREATE TRIGGER inspection_finding_append_only BEFORE UPDATE OR DELETE ON inspection_finding
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- One row per email to send. The worker sends rows whose due_at has passed and sent_at is empty.
CREATE TABLE inspection_notice (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id UUID        NOT NULL REFERENCES inspection(id),
  user_id       UUID        NOT NULL REFERENCES app_user(id),
  kind          TEXT        NOT NULL CHECK (kind IN ('confirmation','reminder','cancellation')),
  due_at        TIMESTAMPTZ NOT NULL,
  sent_at       TIMESTAMPTZ,
  UNIQUE (inspection_id, user_id, kind)
);
CREATE INDEX inspection_notice_due_idx ON inspection_notice (due_at) WHERE sent_at IS NULL;

CREATE TABLE generated_document (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id       UUID        NOT NULL REFERENCES property_listing(id),
  template_id      TEXT        NOT NULL,
  template_version TEXT        NOT NULL,
  version          INTEGER     NOT NULL CHECK (version >= 1),
  supersedes_id    UUID        REFERENCES generated_document(id),
  title            TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body             TEXT        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 60000),
  fields           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  content_sha256   CHAR(64)    NOT NULL,
  created_by       UUID        NOT NULL REFERENCES app_user(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX generated_document_listing_idx ON generated_document (listing_id, created_at);
-- A version can be replaced once only, so concurrent edits cannot fork the history.
CREATE UNIQUE INDEX generated_document_one_successor ON generated_document (supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE TRIGGER generated_document_append_only BEFORE UPDATE OR DELETE ON generated_document
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE TABLE signature_request (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id            UUID        NOT NULL REFERENCES property_listing(id),
  generated_document_id UUID        NOT NULL REFERENCES generated_document(id),
  content_sha256        CHAR(64)    NOT NULL,
  title                 TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  requested_by          UUID        NOT NULL REFERENCES app_user(id),
  status                TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','declined','cancelled','expired')),
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at             TIMESTAMPTZ
);
CREATE INDEX signature_request_listing_idx ON signature_request (listing_id, created_at);
-- At most one open request per document.
CREATE UNIQUE INDEX signature_request_open ON signature_request (generated_document_id) WHERE status = 'pending';

CREATE TABLE signature_signer (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id       UUID        NOT NULL REFERENCES signature_request(id),
  user_id          UUID        NOT NULL REFERENCES app_user(id),
  role_label       TEXT        NOT NULL CHECK (char_length(role_label) BETWEEN 1 AND 40),
  status           TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','signed','declined')),
  viewed_at        TIMESTAMPTZ,
  typed_name       TEXT        CHECK (char_length(typed_name) BETWEEN 2 AND 120),
  consent_version  TEXT,
  signed_at        TIMESTAMPTZ,
  evidence_sha256  CHAR(64),
  ip_hash          CHAR(64),
  decline_reason   TEXT        CHECK (char_length(decline_reason) <= 300),
  UNIQUE (request_id, user_id),
  CHECK (status <> 'signed' OR (typed_name IS NOT NULL AND consent_version IS NOT NULL AND signed_at IS NOT NULL AND evidence_sha256 IS NOT NULL))
);
CREATE INDEX signature_signer_user_idx ON signature_signer (user_id, status);

-- A signature or a decline is final. Only viewed_at may be set on a pending row.
CREATE FUNCTION signature_signer_final() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'signature_signer is an append-only record'; END IF;
  IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'a signature or decline cannot be changed'; END IF;
  IF NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.role_label IS DISTINCT FROM OLD.role_label THEN
    RAISE EXCEPTION 'signer identity cannot be changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER signature_signer_final BEFORE UPDATE OR DELETE ON signature_signer
  FOR EACH ROW EXECUTE FUNCTION signature_signer_final();

CREATE TABLE document_event (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id            UUID        NOT NULL REFERENCES property_listing(id),
  generated_document_id UUID        NOT NULL REFERENCES generated_document(id),
  signature_request_id  UUID        REFERENCES signature_request(id),
  event_type            TEXT        NOT NULL CHECK (event_type IN
    ('created','version_created','viewed','sign_requested','signed','declined','cancelled','completed','expired')),
  actor_user_id         UUID        REFERENCES app_user(id),
  detail                JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX document_event_generated_idx ON document_event (generated_document_id, created_at);
CREATE TRIGGER document_event_append_only BEFORE UPDATE OR DELETE ON document_event
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
