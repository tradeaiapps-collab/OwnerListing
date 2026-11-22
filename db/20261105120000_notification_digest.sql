-- Daily email digest of unread notifications. Opt-in (off by default); one row per user who has ever opened the setting.
--   send_hour    local hour (0-23) in `timezone` at which the hourly worker may send.
--   last_sent_at claimed by the worker before sending, so two overlapping ticks never send twice (a failed send puts the old value back).
CREATE TABLE notification_digest_setting (
  user_id UUID PRIMARY KEY REFERENCES app_user(id),
  enabled BOOLEAN NOT NULL DEFAULT false,
  send_hour SMALLINT NOT NULL DEFAULT 8 CHECK (send_hour BETWEEN 0 AND 23),
  timezone TEXT NOT NULL DEFAULT 'Australia/Sydney' CHECK (char_length(timezone) BETWEEN 1 AND 64),
  last_sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notification_digest_due_idx ON notification_digest_setting(send_hour) WHERE enabled;
