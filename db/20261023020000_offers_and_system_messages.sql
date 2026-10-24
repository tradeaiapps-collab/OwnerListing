-- Automated messages (the offer-link prompt) have no human sender.
ALTER TABLE enquiry_message
  ALTER COLUMN sender_user_id DROP NOT NULL,
  ADD COLUMN automated BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT enquiry_message_sender_chk CHECK (automated OR sender_user_id IS NOT NULL);

-- A submitted offer's terms never change and offers are never deleted. Only status moves.
CREATE OR REPLACE FUNCTION formal_offer_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'formal_offer rows cannot be deleted';
  END IF;
  IF NEW.listing_id <> OLD.listing_id OR NEW.buyer_user_id <> OLD.buyer_user_id
     OR NEW.price_cents <> OLD.price_cents OR NEW.conditions <> OLD.conditions
     OR NEW.settlement_days <> OLD.settlement_days OR NEW.deposit_cents <> OLD.deposit_cents
     OR NEW.link_token_hash <> OLD.link_token_hash OR NEW.submitted_at <> OLD.submitted_at THEN
    RAISE EXCEPTION 'formal_offer terms cannot be changed after submission';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER formal_offer_guard_trg
  BEFORE UPDATE OR DELETE ON formal_offer
  FOR EACH ROW EXECUTE FUNCTION formal_offer_guard();
