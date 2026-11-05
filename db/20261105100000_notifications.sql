-- Notification centre. In-app notifications are the record; email and SMS are optional extra channels, per category, chosen by the user.
--   notification             one row per notification. read_at: opened. archived_at: moved to history (kept until the user deletes it).
--   notification_preference  per user and category: which channels are on. In-app and email default on, SMS and marketing email default off (opt-in).
--   notification_consent_log insert-only evidence of every opt-in and opt-out (GDPR / Spam Act): who, which channel and category, when, from where.
CREATE TABLE notification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_user(id),
  kind TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('messages','appointments','offers','listings','account','marketing')),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  link TEXT CHECK (link IS NULL OR (link LIKE '/%' AND link NOT LIKE '//%' AND char_length(link) <= 300)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ
);
CREATE INDEX notification_user_inbox_idx ON notification(user_id, created_at DESC, id DESC) WHERE archived_at IS NULL;
CREATE INDEX notification_user_all_idx ON notification(user_id, created_at DESC, id DESC);

CREATE TABLE notification_preference (
  user_id UUID NOT NULL REFERENCES app_user(id),
  category TEXT NOT NULL CHECK (category IN ('messages','appointments','offers','listings','account','marketing')),
  in_app BOOLEAN NOT NULL,
  email BOOLEAN NOT NULL,
  sms BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);

CREATE TABLE notification_consent_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(id),
  channel TEXT NOT NULL CHECK (channel IN ('in_app','email','sms')),
  category TEXT NOT NULL CHECK (category IN ('messages','appointments','offers','listings','account','marketing')),
  granted BOOLEAN NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('settings','unsubscribe_link','suggestion')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notification_consent_user_idx ON notification_consent_log(user_id, created_at DESC);

CREATE FUNCTION notification_consent_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'notification_consent_log is insert-only'; END $$;
CREATE TRIGGER notification_consent_log_no_change BEFORE UPDATE OR DELETE ON notification_consent_log
  FOR EACH ROW EXECUTE FUNCTION notification_consent_log_immutable();
