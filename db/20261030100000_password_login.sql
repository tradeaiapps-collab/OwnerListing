-- Email and password sign-in, alongside Google. Passwords are kept only as scrypt hashes (src/server/auth/password.ts).
-- password_changed_at ends every session issued before it (a reset signs the account out everywhere).
ALTER TABLE app_user ADD COLUMN password_hash TEXT;
ALTER TABLE app_user ADD COLUMN password_changed_at TIMESTAMPTZ;

-- One-time links sent by email. Only a keyed hash of the token is stored.
--  signup: the account does not exist yet. The chosen name, type and password hash wait here and the account is created only when
--          the link is used, so nobody can claim an address they cannot read (no unverified accounts, nothing to take over).
--  reset:  sets a new password on an existing account.
CREATE TABLE email_auth_token (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose       TEXT        NOT NULL CHECK (purpose IN ('signup','reset')),
  email         CITEXT      NOT NULL,
  user_id       UUID        REFERENCES app_user(id),
  display_name  TEXT,
  user_type     TEXT        CHECK (user_type IN ('owner','agent','buyer')),
  password_hash TEXT,
  token_hash    CHAR(64)    NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((purpose = 'signup' AND user_id IS NULL AND display_name IS NOT NULL AND user_type IS NOT NULL AND password_hash IS NOT NULL)
      OR (purpose = 'reset' AND user_id IS NOT NULL AND display_name IS NULL AND user_type IS NULL AND password_hash IS NULL))
);
CREATE INDEX email_auth_token_email_idx ON email_auth_token(email, purpose, created_at DESC);
