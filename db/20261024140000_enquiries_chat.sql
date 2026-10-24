-- Buyer-owner enquiry threads. One thread per buyer per listing.
CREATE TABLE enquiry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  buyer_user_id UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id, buyer_user_id)
);
CREATE INDEX enquiry_buyer_idx ON enquiry(buyer_user_id, created_at DESC);

-- Permanent record: no edits or deletes by any application role (same rule as chat_message).
-- sender_user_id is NULL only for automated system messages.
CREATE TABLE enquiry_message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id UUID NOT NULL REFERENCES enquiry(id),
  sender_user_id UUID REFERENCES app_user(id),
  automated BOOLEAN NOT NULL DEFAULT false,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (automated = (sender_user_id IS NULL))
);
CREATE INDEX enquiry_message_thread_idx ON enquiry_message(enquiry_id, sent_at);

CREATE OR REPLACE FUNCTION reject_enquiry_message_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'enquiry_message is a permanent record';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enquiry_message_no_update_delete
  BEFORE UPDATE OR DELETE ON enquiry_message
  FOR EACH ROW EXECUTE FUNCTION reject_enquiry_message_mutation();

-- Unread counts: messages from the other side newer than the viewer's last read time.
CREATE TABLE enquiry_read (
  enquiry_id UUID NOT NULL REFERENCES enquiry(id),
  user_id UUID NOT NULL REFERENCES app_user(id),
  last_read_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (enquiry_id, user_id)
);

-- AI auto-reply PREVIEW. Nothing is sent by any AI: drafts wait for the owner (review window, pause switch).
CREATE TABLE auto_reply_setting (
  owner_user_id UUID PRIMARY KEY REFERENCES app_user(id),
  enabled BOOLEAN NOT NULL DEFAULT false,
  paused BOOLEAN NOT NULL DEFAULT false,
  review_window_minutes INTEGER NOT NULL DEFAULT 30 CHECK (review_window_minutes BETWEEN 1 AND 1440)
);

-- A template exists only because its owner wrote and approved it.
CREATE TABLE enquiry_reply_template (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES app_user(id),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX enquiry_reply_template_owner_idx ON enquiry_reply_template(owner_user_id, approved_at);

CREATE TABLE enquiry_reply_draft (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id UUID NOT NULL REFERENCES enquiry(id),
  template_id UUID NOT NULL REFERENCES enquiry_reply_template(id),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  review_until TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','cancelled','sent_by_owner')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX enquiry_reply_draft_one_queued_idx ON enquiry_reply_draft(enquiry_id) WHERE status = 'queued';
