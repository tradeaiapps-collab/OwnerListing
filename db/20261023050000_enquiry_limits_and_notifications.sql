CREATE INDEX enquiry_message_sender_idx ON enquiry_message(sender_user_id, sent_at) WHERE NOT automated;
CREATE INDEX enquiry_buyer_created_idx ON enquiry(buyer_user_id, created_at);

-- In-app alerts. At most one unread alert per person per conversation, so a burst of messages is one alert.
CREATE TABLE notification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_user(id),
  kind TEXT NOT NULL CHECK (kind IN ('enquiry_message')),
  enquiry_id UUID NOT NULL REFERENCES enquiry(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX notification_one_unread_idx ON notification(user_id, kind, enquiry_id) WHERE read_at IS NULL;
CREATE INDEX notification_user_idx ON notification(user_id, created_at DESC);
