-- Push notifications (phone and browser). Push is one more channel on top of the notification centre: the in-app notification stays the record.
--   push_device       one row per phone app install or browser. token is the FCM/APNs token, or the browser's push endpoint (web).
--   push_preference   per user and topic (the notification categories): whether push is on. Devices only receive what the topic allows.
--   push_delivery     one row per push attempted: the engagement log (sent, failed, opened, dismissed). No message text is kept.
CREATE TABLE push_device (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_user(id),
  platform TEXT NOT NULL CHECK (platform IN ('web','android','ios')),
  token TEXT NOT NULL CHECK (char_length(token) BETWEEN 20 AND 2048),
  p256dh TEXT CHECK (p256dh IS NULL OR char_length(p256dh) BETWEEN 20 AND 200),
  auth_secret TEXT CHECK (auth_secret IS NULL OR char_length(auth_secret) BETWEEN 10 AND 100),
  label TEXT CHECK (label IS NULL OR char_length(label) <= 80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT push_device_web_keys CHECK (platform <> 'web' OR (p256dh IS NOT NULL AND auth_secret IS NOT NULL))
);
CREATE UNIQUE INDEX push_device_token_idx ON push_device(token);
CREATE INDEX push_device_user_idx ON push_device(user_id) WHERE revoked_at IS NULL;

CREATE TABLE push_preference (
  user_id UUID NOT NULL REFERENCES app_user(id),
  category TEXT NOT NULL CHECK (category IN ('messages','appointments','offers','listings','account','marketing')),
  enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);

CREATE TABLE push_delivery (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_user(id),
  device_id UUID NOT NULL REFERENCES push_device(id),
  notification_id UUID REFERENCES notification(id) ON DELETE SET NULL,
  platform TEXT NOT NULL CHECK (platform IN ('web','android','ios')),
  kind TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('messages','appointments','offers','listings','account','marketing')),
  personalized BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','gone')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  clicked_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ
);
CREATE INDEX push_delivery_created_idx ON push_delivery(created_at);
CREATE INDEX push_delivery_user_idx ON push_delivery(user_id, created_at DESC);

-- Push opt-ins and opt-outs are consent evidence like the other channels.
ALTER TABLE notification_consent_log DROP CONSTRAINT notification_consent_log_channel_check;
ALTER TABLE notification_consent_log ADD CONSTRAINT notification_consent_log_channel_check CHECK (channel IN ('in_app','email','sms','push'));
