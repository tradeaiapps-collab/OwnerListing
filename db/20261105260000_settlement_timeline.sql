-- Settlement / conveyancing tracker: one timeline per accepted offer, eight milestones, and a simple JSON checklist per stage and role.
-- Nothing is deleted. Moving money, signing and reminders are not part of this: it records who has done what and when.

CREATE TABLE settlement_timeline (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id UUID NOT NULL UNIQUE REFERENCES formal_offer(id),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  buyer_id UUID NOT NULL REFERENCES app_user(id),
  seller_id UUID NOT NULL REFERENCES app_user(id),
  agent_id UUID REFERENCES app_user(id),
  state TEXT NOT NULL,
  current_stage TEXT NOT NULL CHECK (current_stage IN ('offer_accepted','deposit_received','cooling_off_expires','inspection_completed','finance_approval','lawyer_exchange','settlement_scheduled','settlement_completed')),
  stage_entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX settlement_timeline_buyer_idx ON settlement_timeline(buyer_id);
CREATE INDEX settlement_timeline_seller_idx ON settlement_timeline(seller_id);
CREATE INDEX settlement_timeline_listing_idx ON settlement_timeline(listing_id);
CREATE INDEX settlement_timeline_open_idx ON settlement_timeline(stage_entered_at) WHERE completed_at IS NULL;

CREATE TABLE settlement_milestones (
  settlement_id UUID NOT NULL REFERENCES settlement_timeline(id),
  stage TEXT NOT NULL CHECK (stage IN ('offer_accepted','deposit_received','cooling_off_expires','inspection_completed','finance_approval','lawyer_exchange','settlement_scheduled','settlement_completed')),
  target_date DATE,
  actual_date DATE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','blocked')),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (settlement_id, stage),
  CHECK ((status = 'completed') = (actual_date IS NOT NULL))
);

CREATE TABLE settlement_checklists (
  settlement_id UUID NOT NULL REFERENCES settlement_timeline(id),
  milestone_stage TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('buyer','seller','agent','lawyer')),
  -- [{ "id": "buyer-0", "label": "...", "done": false, "doneAt": null, "doneByRole": null }]
  items JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(items) = 'array'),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (settlement_id, milestone_stage, role),
  FOREIGN KEY (settlement_id, milestone_stage) REFERENCES settlement_milestones(settlement_id, stage)
);

CREATE OR REPLACE FUNCTION reject_settlement_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'settlement records are a permanent record';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER settlement_timeline_no_delete BEFORE DELETE ON settlement_timeline FOR EACH ROW EXECUTE FUNCTION reject_settlement_delete();
CREATE TRIGGER settlement_milestones_no_delete BEFORE DELETE ON settlement_milestones FOR EACH ROW EXECUTE FUNCTION reject_settlement_delete();
CREATE TRIGGER settlement_checklists_no_delete BEFORE DELETE ON settlement_checklists FOR EACH ROW EXECUTE FUNCTION reject_settlement_delete();
