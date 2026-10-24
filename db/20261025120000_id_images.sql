-- In-house photo-ID and selfie images for the manual identity review (db/015).
-- Images are AES-256-GCM encrypted by the server and kept only in object storage; the database holds random storage keys,
-- SHA-256 hashes and the detected type. Document numbers are never stored.

ALTER TABLE id_submission
  ADD COLUMN front_sha256 CHAR(64),
  ADD COLUMN back_sha256 CHAR(64),
  ADD COLUMN selfie_sha256 CHAR(64),
  ADD COLUMN front_mime TEXT CHECK (front_mime IN ('image/jpeg','image/png','image/webp')),
  ADD COLUMN back_mime TEXT CHECK (back_mime IN ('image/jpeg','image/png','image/webp')),
  ADD COLUMN selfie_mime TEXT CHECK (selfie_mime IN ('image/jpeg','image/png','image/webp')),
  ADD COLUMN consent_version TEXT,
  ADD COLUMN assigned_reviewer UUID REFERENCES app_user(id),
  ADD COLUMN assigned_at TIMESTAMPTZ,
  -- Once the retention job has deleted the images, no key or hash may remain.
  ADD CONSTRAINT id_submission_images_gone CHECK (
    images_deleted_at IS NULL OR (front_image_key IS NULL AND back_image_key IS NULL AND selfie_key IS NULL
      AND front_sha256 IS NULL AND back_sha256 IS NULL AND selfie_sha256 IS NULL));

-- One submission waiting for review per buyer (double submit).
CREATE UNIQUE INDEX id_submission_one_pending ON id_submission(user_id) WHERE status = 'pending';
CREATE INDEX id_submission_retention_idx ON id_submission(decided_at) WHERE images_deleted_at IS NULL AND decided_at IS NOT NULL;

-- Privacy notice consent, recorded before any image is accepted. Insert only.
CREATE TABLE id_image_consent (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES app_user(id),
  wording_version TEXT        NOT NULL,
  consented_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX id_image_consent_user_idx ON id_image_consent(user_id, consented_at);
CREATE TRIGGER id_image_consent_append_only
  BEFORE UPDATE OR DELETE ON id_image_consent
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- Every upload attempt, claim, integrity failure and retention deletion. Insert only. ip_hash is a keyed HMAC, never the address.
CREATE TABLE id_submission_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES app_user(id),
  submission_id UUID REFERENCES id_submission(id),
  staff_user_id UUID REFERENCES app_user(id),
  event         TEXT        NOT NULL CHECK (event IN ('submitted','refused','rate_limited','scan_infected','store_failed','claimed','integrity_failed','images_deleted','delete_failed')),
  ip_hash       CHAR(64),
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX id_submission_log_user_idx ON id_submission_log(user_id, occurred_at);
CREATE TRIGGER id_submission_log_append_only
  BEFORE UPDATE OR DELETE ON id_submission_log
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
