-- One enquiry thread per buyer per listing. Messages are permanent: no edit or delete, enforced in the database.
CREATE TABLE enquiry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  buyer_user_id UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id, buyer_user_id)
);
CREATE INDEX enquiry_buyer_idx ON enquiry(buyer_user_id, created_at DESC);

CREATE TABLE enquiry_message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id UUID NOT NULL REFERENCES enquiry(id),
  sender_user_id UUID NOT NULL REFERENCES app_user(id),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX enquiry_message_thread_idx ON enquiry_message(enquiry_id, sent_at);
CREATE TRIGGER enquiry_message_append_only
  BEFORE UPDATE OR DELETE ON enquiry_message
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
