-- Inspection workflows: schedule an inspector, record findings and photos, share the report, track follow-ups.
-- Nothing here is deleted by the application: findings and photos are a permanent record, shares are revoked, not removed.

CREATE TABLE inspection (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  requested_by UUID NOT NULL REFERENCES app_user(id),
  inspector_user_id UUID NOT NULL REFERENCES app_user(id),
  inspection_type TEXT NOT NULL CHECK (inspection_type IN ('building','pest','pre_purchase','pre_sale','other')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','accepted','declined','completed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  -- Elena's written summary. A draft until a person approves it; shared viewers only ever see an approved one.
  summary_text TEXT CHECK (summary_text IS NULL OR length(summary_text) <= 4000),
  summary_source TEXT CHECK (summary_source IN ('ai','rules')),
  summary_prompt_version TEXT,
  summary_generated_by UUID REFERENCES app_user(id),
  summary_generated_at TIMESTAMPTZ,
  summary_approved_by UUID REFERENCES app_user(id),
  summary_approved_at TIMESTAMPTZ,
  CONSTRAINT inspection_inspector_not_requester CHECK (inspector_user_id <> requested_by)
);
CREATE INDEX inspection_listing_idx ON inspection(listing_id, scheduled_at);
CREATE INDEX inspection_inspector_idx ON inspection(inspector_user_id, scheduled_at);

CREATE TABLE inspection_finding (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id UUID NOT NULL REFERENCES inspection(id),
  area TEXT NOT NULL CHECK (length(area) BETWEEN 1 AND 80),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  detail TEXT NOT NULL DEFAULT '' CHECK (length(detail) <= 2000),
  severity TEXT NOT NULL CHECK (severity IN ('info','minor','moderate','major','critical')),
  followup_status TEXT NOT NULL CHECK (followup_status IN ('none','open','in_progress','resolved','wont_fix')),
  followup_note TEXT NOT NULL DEFAULT '' CHECK (length(followup_note) <= 1000),
  followup_updated_by UUID REFERENCES app_user(id),
  followup_updated_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inspection_finding_idx ON inspection_finding(inspection_id, created_at);

CREATE TABLE inspection_photo (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id UUID NOT NULL REFERENCES inspection(id),
  finding_id UUID REFERENCES inspection_finding(id),
  uploaded_by UUID NOT NULL REFERENCES app_user(id),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inspection_photo_idx ON inspection_photo(inspection_id, uploaded_at);

CREATE TABLE inspection_share (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id UUID NOT NULL REFERENCES inspection(id),
  shared_with_user_id UUID NOT NULL REFERENCES app_user(id),
  shared_by UUID NOT NULL REFERENCES app_user(id),
  shared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX inspection_share_live_idx ON inspection_share(inspection_id, shared_with_user_id) WHERE revoked_at IS NULL;
CREATE INDEX inspection_share_user_idx ON inspection_share(shared_with_user_id);

-- Findings and photos of a finished inspection cannot be changed or removed; only the follow-up columns move.
CREATE OR REPLACE FUNCTION inspection_record_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '% is a permanent record', TG_TABLE_NAME; END IF;
  IF TG_TABLE_NAME = 'inspection_photo' THEN RAISE EXCEPTION 'inspection_photo is a permanent record'; END IF;
  IF NEW.inspection_id <> OLD.inspection_id OR NEW.area <> OLD.area OR NEW.title <> OLD.title OR NEW.detail <> OLD.detail
     OR NEW.severity <> OLD.severity OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'inspection findings cannot be edited; add a new finding';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER inspection_finding_guard BEFORE UPDATE OR DELETE ON inspection_finding FOR EACH ROW EXECUTE FUNCTION inspection_record_guard();
CREATE TRIGGER inspection_photo_guard BEFORE UPDATE OR DELETE ON inspection_photo FOR EACH ROW EXECUTE FUNCTION inspection_record_guard();
CREATE OR REPLACE FUNCTION inspection_no_delete() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is a permanent record', TG_TABLE_NAME; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER inspection_no_delete BEFORE DELETE ON inspection FOR EACH ROW EXECUTE FUNCTION inspection_no_delete();
CREATE TRIGGER inspection_share_no_delete BEFORE DELETE ON inspection_share FOR EACH ROW EXECUTE FUNCTION inspection_no_delete();
