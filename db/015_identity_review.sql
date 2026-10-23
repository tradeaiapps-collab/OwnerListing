-- Interim in-house identity review. Document numbers are never stored.
-- Images live in private, encrypted storage and are deleted shortly after a decision.
CREATE TABLE id_submission (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_user(id),
  document_kind TEXT NOT NULL CHECK (document_kind IN ('drivers_licence','passport','other_government_id')),
  document_country CHAR(2) NOT NULL,
  expiry_date DATE NOT NULL,
  front_image_key TEXT,
  back_image_key TEXT,
  selfie_key TEXT,
  selfie_captured_in_app BOOLEAN NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','needs_more')),
  approvals JSONB NOT NULL DEFAULT '[]'::jsonb,
  decided_at TIMESTAMPTZ,
  images_deleted_at TIMESTAMPTZ
);
CREATE INDEX id_submission_pending_idx ON id_submission(submitted_at) WHERE status = 'pending';

-- Every time a reviewer opens an image. Insert only.
CREATE TABLE id_review_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES id_submission(id),
  staff_user_id UUID NOT NULL REFERENCES app_user(id),
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  purpose TEXT NOT NULL
);
CREATE TRIGGER id_review_access_append_only
  BEFORE UPDATE OR DELETE ON id_review_access
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

ALTER TABLE buyer_verification
  ADD COLUMN id_method TEXT CHECK (id_method IN ('manual_review','provider'));
