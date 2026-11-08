-- Agent lead CRM: one lead per (listing, appointed agent, buyer), created automatically from what the buyer does on the platform
-- (enquiry, viewing request, inspection request) and moved on by an offer. Triggers do the capture so every code path is covered and
-- the lead is written in the same transaction as the buyer's action. Nothing is deleted by the application.
-- Names are agent_lead* / lead_interaction (ad leads are ad_lead*, Elena's chat qualifier owns `lead`).
-- Privacy: an offer never creates a lead (the platform hides buyer identity from the seller side of an offer); it only moves a lead the
-- agent already has through an enquiry, viewing or inspection.

CREATE TABLE agent_lead (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  agent_id UUID NOT NULL REFERENCES app_user(id),
  buyer_id UUID NOT NULL REFERENCES app_user(id),
  status TEXT NOT NULL DEFAULT 'new_inquiry' CHECK (status IN ('new_inquiry','viewing_scheduled','offer_pending','lost','converted')),
  lost_reason TEXT CHECK (lost_reason IS NULL OR lost_reason IN ('budget','location','other')),
  lost_note TEXT NOT NULL DEFAULT '' CHECK (length(lost_note) <= 500),
  converted_offer_id UUID REFERENCES formal_offer(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_interaction_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Latest activity from each side; the dashboard colour and "awaiting your reply" come from comparing them.
  last_buyer_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_agent_at TIMESTAMPTZ,
  first_response_at TIMESTAMPTZ,
  next_followup_at TIMESTAMPTZ,
  followup_note TEXT NOT NULL DEFAULT '' CHECK (length(followup_note) <= 300),
  followup_notified_at TIMESTAMPTZ,
  notes JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(notes) = 'array' AND jsonb_array_length(notes) <= 200),
  CONSTRAINT agent_lead_lost_has_reason CHECK (status <> 'lost' OR lost_reason IS NOT NULL),
  UNIQUE (listing_id, agent_id, buyer_id)
);
CREATE INDEX agent_lead_agent_idx ON agent_lead(agent_id, status, last_interaction_at DESC);
CREATE INDEX agent_lead_due_idx ON agent_lead(next_followup_at) WHERE next_followup_at IS NOT NULL AND status NOT IN ('lost','converted');

CREATE TABLE lead_interaction (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES agent_lead(id),
  interaction_type TEXT NOT NULL CHECK (interaction_type IN ('inquiry','viewing','inspection','offer','message')),
  actor TEXT NOT NULL CHECK (actor IN ('buyer','agent','system')),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lead_interaction_lead_idx ON lead_interaction(lead_id, created_at DESC);

-- Records one buyer or agent action against the lead of the listing's current appointed agent. `p_create` false means "only if the lead exists".
-- Status only moves forward (new < viewing < offer), a lost lead reopens when the buyer comes back, a converted lead stays converted.
CREATE OR REPLACE FUNCTION agent_lead_record(p_listing UUID, p_buyer UUID, p_type TEXT, p_actor TEXT, p_desc TEXT, p_status TEXT, p_create BOOLEAN)
RETURNS void AS $$
DECLARE
  v_agent UUID;
  v_lead UUID;
BEGIN
  SELECT agent_user_id INTO v_agent FROM listing_agent_appointment
   WHERE listing_id = p_listing AND revoked_at IS NULL AND (permissions IS NULL OR 'enquiries.handle' = ANY(permissions)) LIMIT 1;
  IF v_agent IS NULL OR v_agent = p_buyer THEN RETURN; END IF;

  IF p_create THEN
    INSERT INTO agent_lead (listing_id, agent_id, buyer_id, status) VALUES (p_listing, v_agent, p_buyer, 'new_inquiry')
    ON CONFLICT (listing_id, agent_id, buyer_id) DO NOTHING;
  END IF;
  SELECT id INTO v_lead FROM agent_lead WHERE listing_id = p_listing AND agent_id = v_agent AND buyer_id = p_buyer;
  IF v_lead IS NULL THEN RETURN; END IF;

  UPDATE agent_lead SET
    status = CASE
      WHEN status = 'converted' THEN status
      WHEN p_status IS NULL THEN status
      WHEN status = 'lost' THEN p_status
      WHEN array_position(ARRAY['new_inquiry','viewing_scheduled','offer_pending'], p_status) > array_position(ARRAY['new_inquiry','viewing_scheduled','offer_pending'], status) THEN p_status
      ELSE status END,
    lost_reason = CASE WHEN status = 'lost' AND p_actor = 'buyer' AND p_status IS NOT NULL THEN NULL ELSE lost_reason END,
    last_interaction_at = now(),
    last_buyer_at = CASE WHEN p_actor = 'buyer' THEN now() ELSE last_buyer_at END,
    last_agent_at = CASE WHEN p_actor = 'agent' THEN now() ELSE last_agent_at END,
    first_response_at = CASE WHEN p_actor = 'agent' AND first_response_at IS NULL THEN now() ELSE first_response_at END
  WHERE id = v_lead;
  INSERT INTO lead_interaction (lead_id, interaction_type, actor, description) VALUES (v_lead, p_type, p_actor, p_desc);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION agent_lead_from_enquiry() RETURNS trigger AS $$
BEGIN
  PERFORM agent_lead_record(NEW.listing_id, NEW.buyer_user_id, 'inquiry', 'buyer', 'Sent an enquiry about the listing', 'new_inquiry', true);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER agent_lead_enquiry AFTER INSERT ON enquiry FOR EACH ROW EXECUTE FUNCTION agent_lead_from_enquiry();

CREATE OR REPLACE FUNCTION agent_lead_from_message() RETURNS trigger AS $$
DECLARE
  e RECORD;
BEGIN
  IF NEW.automated OR NEW.sender_user_id IS NULL THEN RETURN NEW; END IF;
  SELECT listing_id, buyer_user_id INTO e FROM enquiry WHERE id = NEW.enquiry_id;
  IF e.listing_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.sender_user_id = e.buyer_user_id THEN
    PERFORM agent_lead_record(e.listing_id, e.buyer_user_id, 'message', 'buyer', 'Buyer sent a message', 'new_inquiry', true);
  ELSIF EXISTS (SELECT 1 FROM agent_lead WHERE listing_id = e.listing_id AND buyer_id = e.buyer_user_id AND agent_id = NEW.sender_user_id) THEN
    UPDATE agent_lead SET last_interaction_at = now(), last_agent_at = now(), first_response_at = COALESCE(first_response_at, now())
     WHERE listing_id = e.listing_id AND buyer_id = e.buyer_user_id AND agent_id = NEW.sender_user_id;
    INSERT INTO lead_interaction (lead_id, interaction_type, actor, description)
      SELECT id, 'message', 'agent', 'You replied to the buyer' FROM agent_lead WHERE listing_id = e.listing_id AND buyer_id = e.buyer_user_id AND agent_id = NEW.sender_user_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER agent_lead_message AFTER INSERT ON enquiry_message FOR EACH ROW EXECUTE FUNCTION agent_lead_from_message();

CREATE OR REPLACE FUNCTION agent_lead_from_viewing() RETURNS trigger AS $$
BEGIN
  IF NEW.kind = 'viewing' THEN
    PERFORM agent_lead_record(NEW.listing_id, NEW.requester_user_id, 'viewing', 'buyer', 'Asked to view the property on ' || to_char(NEW.starts_at AT TIME ZONE 'Australia/Sydney', 'DD Mon YYYY HH24:MI'), 'viewing_scheduled', true);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER agent_lead_viewing AFTER INSERT ON viewing_booking FOR EACH ROW EXECUTE FUNCTION agent_lead_from_viewing();

CREATE OR REPLACE FUNCTION agent_lead_from_inspection() RETURNS trigger AS $$
BEGIN
  PERFORM agent_lead_record(NEW.listing_id, NEW.buyer_id, 'inspection', 'buyer', 'Requested a property inspection', 'viewing_scheduled', true);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER agent_lead_inspection AFTER INSERT ON inspection_booking FOR EACH ROW EXECUTE FUNCTION agent_lead_from_inspection();

-- An offer moves an existing lead only; it never reveals a buyer to the agent who had no earlier contact with them.
CREATE OR REPLACE FUNCTION agent_lead_from_offer() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM agent_lead_record(NEW.listing_id, NEW.buyer_user_id, 'offer', 'buyer', 'Buyer submitted an offer', 'offer_pending', false);
  ELSIF NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted' THEN
    WITH l AS (
      UPDATE agent_lead SET status = 'converted', converted_offer_id = NEW.id, lost_reason = NULL, next_followup_at = NULL, last_interaction_at = now()
       WHERE listing_id = NEW.listing_id AND buyer_id = NEW.buyer_user_id AND status <> 'converted' RETURNING id)
    INSERT INTO lead_interaction (lead_id, interaction_type, actor, description) SELECT id, 'offer', 'system', 'The owner accepted the buyer''s offer' FROM l;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER agent_lead_offer AFTER INSERT OR UPDATE OF status ON formal_offer FOR EACH ROW EXECUTE FUNCTION agent_lead_from_offer();
