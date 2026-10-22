ALTER TABLE property_document
  ADD COLUMN declared_mime TEXT NOT NULL,
  ADD COLUMN size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'parties' CHECK (visibility IN ('public','parties','owner_only')),
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','held','superseded')),
  ADD COLUMN supersedes_id UUID REFERENCES property_document(id);

-- Every deletion request and its outcome. Insert only.
-- Before first publish the owner can delete; after the owner's final approval files can only be amended
-- (new version, old version kept as 'superseded'). Chat history has no deletion path at all.
CREATE TABLE document_deletion_request (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES property_document(id),
  requested_by UUID NOT NULL REFERENCES app_user(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome TEXT NOT NULL CHECK (outcome IN ('delete_now','amend_only','held','rejected')),
  reason TEXT
);
