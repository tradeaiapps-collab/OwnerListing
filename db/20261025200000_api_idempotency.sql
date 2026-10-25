-- Idempotency keys for API writes (see src/server/api/idempotency.ts). One row per (caller scope, key); rows expire after 24 hours
-- and are taken over on the next use of the same key after that. Only successful responses are stored.
CREATE TABLE api_idempotency_key (
  -- Who sent it: "user:<id>", "staff:<id>" or "anon:<keyed hash of the IP>". Keys never resolve across callers.
  scope            TEXT        NOT NULL CHECK (length(scope) BETWEEN 1 AND 200),
  idem_key         UUID        NOT NULL,
  method           TEXT        NOT NULL CHECK (method IN ('POST','PUT','PATCH','DELETE')),
  path             TEXT        NOT NULL CHECK (length(path) <= 2000),
  request_hash     CHAR(64)    NOT NULL,
  state            TEXT        NOT NULL DEFAULT 'in_progress' CHECK (state IN ('in_progress','completed')),
  locked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  response_status  SMALLINT,
  response_headers JSONB,
  response_body    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope, idem_key),
  CHECK (state = 'in_progress' OR (response_status IS NOT NULL AND completed_at IS NOT NULL))
);
-- For a periodic purge of expired rows (DELETE FROM api_idempotency_key WHERE expires_at < now()).
CREATE INDEX api_idempotency_key_expires_idx ON api_idempotency_key(expires_at);
