-- Phone app sign-in. One row per signed-in app install. The app holds a short access token and a rotating refresh token;
-- only the SHA-256 of the refresh secret is kept. When a refresh token that was already swapped for a new one comes back, the
-- whole session is revoked (someone copied it). mfa_at is when this phone last passed the second sign-in step.
CREATE TABLE mobile_session (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(id),
  user_type TEXT NOT NULL CHECK (user_type IN ('owner','agent','buyer','vendor')),
  refresh_hash TEXT NOT NULL CHECK (char_length(refresh_hash) = 64),
  previous_refresh_hash TEXT CHECK (previous_refresh_hash IS NULL OR char_length(previous_refresh_hash) = 64),
  device_label TEXT CHECK (device_label IS NULL OR char_length(device_label) <= 80),
  platform TEXT CHECK (platform IS NULL OR platform IN ('android','ios')),
  mfa_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  max_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT CHECK (revoked_reason IS NULL OR revoked_reason IN ('sign_out','reuse','account','expired'))
);
CREATE INDEX mobile_session_user_idx ON mobile_session(user_id) WHERE revoked_at IS NULL;

-- Every refresh secret this session has already swapped (hash only). Any of them coming back means a copy exists: the session is revoked.
CREATE TABLE mobile_session_retired_refresh (
  session_id UUID NOT NULL REFERENCES mobile_session(id),
  refresh_hash TEXT NOT NULL CHECK (char_length(refresh_hash) = 64),
  retired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, refresh_hash)
);

-- A phone's push registration belongs to the phone session that made it: once that session ends (sign-out, stolen token, password
-- or MFA reset, suspension), the phone stops receiving pushes even if the app never unregistered. NULL for browsers.
ALTER TABLE push_device ADD COLUMN mobile_session_id UUID REFERENCES mobile_session(id);
