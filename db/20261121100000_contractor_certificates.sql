-- Contractor certificates: the licence and insurance certificate files a contractor uploads (PDF or photo), and the log of expiry emails.
-- Files are never deleted. A newer upload of the same kind supersedes the older one (kept for audit). Bytes live in object storage under cert/<user>/<random>.

CREATE TABLE contractor_certificate (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES app_user(id),
  kind          TEXT NOT NULL CHECK (kind IN ('insurance', 'licence')),
  storage_key   TEXT NOT NULL UNIQUE,
  sha256        TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  declared_mime TEXT NOT NULL CHECK (declared_mime IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic')),
  size_bytes    INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10000000),
  expiry_date   DATE NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One current certificate per contractor and kind.
CREATE UNIQUE INDEX contractor_certificate_active_idx ON contractor_certificate (user_id, kind) WHERE status = 'active';
CREATE INDEX contractor_certificate_user_idx ON contractor_certificate (user_id, uploaded_at);

-- One row per email sent: the primary key makes the daily job safe to run every tick and to re-run after a crash.
-- milestone: 30 (30 days or fewer left), 7 (7 days or fewer), 0 (expired).
CREATE TABLE contractor_expiry_notice (
  user_id     UUID NOT NULL REFERENCES app_user(id),
  kind        TEXT NOT NULL CHECK (kind IN ('insurance', 'licence')),
  expiry_date DATE NOT NULL,
  milestone   INTEGER NOT NULL CHECK (milestone IN (30, 7, 0)),
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, expiry_date, milestone)
);
