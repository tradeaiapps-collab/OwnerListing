-- Alerts can now be about an offer as well as an enquiry.
ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check
  CHECK (kind IN ('enquiry_message','offer_submitted','offer_decided','offer_withdrawn'));
ALTER TABLE notification ALTER COLUMN enquiry_id DROP NOT NULL;
ALTER TABLE notification ADD COLUMN offer_id UUID REFERENCES formal_offer(id);
ALTER TABLE notification ADD CONSTRAINT notification_one_subject_check
  CHECK ((enquiry_id IS NOT NULL) <> (offer_id IS NOT NULL));
CREATE UNIQUE INDEX notification_offer_unread_idx ON notification(user_id, kind, offer_id) WHERE read_at IS NULL AND offer_id IS NOT NULL;
