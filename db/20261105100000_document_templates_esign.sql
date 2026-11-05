-- Document templates, generated documents and e-signatures.
-- Templates and their versions are insert-only (publishing is its own insert-only log, like the guide assistant); a generated
-- document freezes the rendered text and its SHA-256 at creation; every step of a signing is an insert-only event row.
--
-- Rollback (manual, only when no document was ever generated): DROP TABLE signing_event, signing_signer, signing_document,
--   doc_template_publish, doc_template_version, doc_template; delete this file's row from schema_migration.

CREATE TABLE doc_template (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key TEXT NOT NULL UNIQUE CHECK (template_key ~ '^[a-z0-9_]{3,40}$'),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  category TEXT NOT NULL CHECK (category IN ('contract','disclosure','agreement')),
  created_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- content = { fields: [...], clauses: [...] }, validated in src/domain/doc-templates.ts. Plain text only.
CREATE TABLE doc_template_version (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES doc_template(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object' AND octet_length(content::text) <= 131072),
  change_note TEXT NOT NULL DEFAULT '' CHECK (char_length(change_note) <= 500),
  created_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

-- The live version of a template is the version named by its latest publish row.
CREATE TABLE doc_template_publish (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_id UUID NOT NULL REFERENCES doc_template(id),
  version_id UUID NOT NULL REFERENCES doc_template_version(id),
  published_by UUID NOT NULL REFERENCES app_user(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX doc_template_publish_template_idx ON doc_template_publish(template_id, id DESC);

CREATE TRIGGER doc_template_append_only BEFORE UPDATE OR DELETE ON doc_template
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER doc_template_version_append_only BEFORE UPDATE OR DELETE ON doc_template_version
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER doc_template_publish_append_only BEFORE UPDATE OR DELETE ON doc_template_publish
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- A document generated for one listing from one template version. rendered = { clauses: [{id, heading, text, explanation}] } with the
-- values filled in; body_sha256 is the hash of the title and clauses and is what every signature refers to.
CREATE TABLE signing_document (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  template_version_id UUID NOT NULL REFERENCES doc_template_version(id),
  created_by UUID NOT NULL REFERENCES app_user(id),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  rendered JSONB NOT NULL CHECK (jsonb_typeof(rendered) = 'object'),
  field_values JSONB NOT NULL CHECK (jsonb_typeof(field_values) = 'object'),
  body_sha256 CHAR(64) NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','out_for_signature','completed','declined','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ
);
CREATE INDEX signing_document_listing_idx ON signing_document(listing_id, created_at DESC);

CREATE TABLE signing_signer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES signing_document(id),
  user_id UUID NOT NULL REFERENCES app_user(id),
  role_label TEXT NOT NULL CHECK (char_length(role_label) BETWEEN 2 AND 60),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','signed','declined')),
  typed_name TEXT,
  signed_at TIMESTAMPTZ,
  UNIQUE (document_id, user_id),
  CHECK ((status = 'signed') = (typed_name IS NOT NULL AND signed_at IS NOT NULL))
);
CREATE INDEX signing_signer_user_idx ON signing_signer(user_id);

CREATE TABLE signing_event (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES signing_document(id),
  signer_id UUID REFERENCES signing_signer(id),
  actor_user_id UUID NOT NULL REFERENCES app_user(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('created','sent','viewed','explained','signed','declined','completed','cancelled')),
  body_sha256 CHAR(64) NOT NULL,
  ip TEXT,
  user_agent TEXT CHECK (char_length(user_agent) <= 300),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX signing_event_document_idx ON signing_event(document_id, id);
CREATE TRIGGER signing_event_append_only BEFORE UPDATE OR DELETE ON signing_event
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- Once generated, the text, its hash, the values, the template version and the listing never change; only status and the
-- timestamps move. Nothing is ever deleted. A signature on a signer row is final.
CREATE OR REPLACE FUNCTION signing_document_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'signing documents are a permanent record'; END IF;
  IF NEW.rendered IS DISTINCT FROM OLD.rendered OR NEW.body_sha256 IS DISTINCT FROM OLD.body_sha256
     OR NEW.field_values IS DISTINCT FROM OLD.field_values OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'the text of a generated document cannot change';
  END IF;
  IF OLD.status IN ('completed','declined','cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a closed document cannot be reopened';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER signing_document_guard BEFORE UPDATE OR DELETE ON signing_document
  FOR EACH ROW EXECUTE FUNCTION signing_document_guard();

CREATE OR REPLACE FUNCTION signing_signer_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'signers are a permanent record'; END IF;
  IF NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'a signer cannot be changed';
  END IF;
  IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'a signature or decline is final'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER signing_signer_guard BEFORE UPDATE OR DELETE ON signing_signer
  FOR EACH ROW EXECUTE FUNCTION signing_signer_guard();
