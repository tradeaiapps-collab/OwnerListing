-- DocuSign as the signing provider for compliance-grade documents. The built-in click-to-sign stays as the fallback, so every
-- document records which provider owns it. Text, hash and audit trail rules from 20261105100000 are unchanged.

ALTER TABLE signing_document
  ADD COLUMN provider TEXT NOT NULL DEFAULT 'builtin' CHECK (provider IN ('builtin','docusign')),
  ADD COLUMN esign_envelope_id TEXT CHECK (esign_envelope_id IS NULL OR char_length(esign_envelope_id) BETWEEN 8 AND 80),
  ADD COLUMN retry_of UUID REFERENCES signing_document(id);
CREATE UNIQUE INDEX signing_document_envelope_idx ON signing_document(esign_envelope_id) WHERE esign_envelope_id IS NOT NULL;

ALTER TABLE signing_signer
  ADD COLUMN esign_recipient_id TEXT CHECK (esign_recipient_id IS NULL OR char_length(esign_recipient_id) BETWEEN 1 AND 40);

-- More audit event types: DocuSign delivery, a voided envelope, a retry of a declined or cancelled document, a stored copy.
ALTER TABLE signing_event DROP CONSTRAINT signing_event_event_type_check;
ALTER TABLE signing_event ADD CONSTRAINT signing_event_event_type_check
  CHECK (event_type IN ('created','sent','viewed','explained','signed','declined','completed','cancelled','voided','retried','stored'));

-- Same guard as before, plus: provider, envelope and retry link are set once and never change.
CREATE OR REPLACE FUNCTION signing_document_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'signing documents are a permanent record'; END IF;
  IF NEW.rendered IS DISTINCT FROM OLD.rendered OR NEW.body_sha256 IS DISTINCT FROM OLD.body_sha256
     OR NEW.field_values IS DISTINCT FROM OLD.field_values OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'the text of a generated document cannot change';
  END IF;
  IF NEW.provider IS DISTINCT FROM OLD.provider OR NEW.retry_of IS DISTINCT FROM OLD.retry_of
     OR (OLD.esign_envelope_id IS NOT NULL AND NEW.esign_envelope_id IS DISTINCT FROM OLD.esign_envelope_id) THEN
    RAISE EXCEPTION 'the signing provider and envelope of a document cannot change';
  END IF;
  IF OLD.status IN ('completed','declined','cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a closed document cannot be reopened';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Signed copies and the provider's certificate of completion. Bytes live in object storage; only key, hash and size here.
-- The signed PDF is also added to the listing's document history (property_document, kind contract).
CREATE TABLE signing_artifact (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES signing_document(id),
  kind TEXT NOT NULL CHECK (kind IN ('signed_pdf','certificate')),
  storage_key TEXT NOT NULL,
  sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  property_document_id UUID REFERENCES property_document(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, kind)
);
CREATE TRIGGER signing_artifact_append_only BEFORE UPDATE OR DELETE ON signing_artifact
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
