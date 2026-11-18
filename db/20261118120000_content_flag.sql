-- Text the content filter refused (blocked) or let through with a warning (flagged): messages and profile text.
-- Shared with the staff moderation queue. Rows are never deleted; staff review each one once.
CREATE TABLE content_flag (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('message','profile')),
  subject_type TEXT NOT NULL,
  subject_id UUID,
  field TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES app_user(id),
  action TEXT NOT NULL CHECK (action IN ('flag','block')),
  categories TEXT[] NOT NULL CHECK (cardinality(categories) >= 1),
  hits JSONB NOT NULL,
  excerpt TEXT NOT NULL CHECK (char_length(excerpt) <= 500),
  rules_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID REFERENCES app_user(id),
  reviewed_at TIMESTAMPTZ,
  review_outcome TEXT CHECK (review_outcome IN ('confirmed','dismissed')),
  review_note TEXT CHECK (review_note IS NULL OR char_length(review_note) BETWEEN 1 AND 500),
  CHECK ((reviewed_at IS NULL) = (review_outcome IS NULL) AND (reviewed_at IS NULL) = (reviewed_by IS NULL))
);
CREATE INDEX content_flag_open_idx ON content_flag(created_at) WHERE reviewed_at IS NULL;
CREATE INDEX content_flag_user_idx ON content_flag(user_id, created_at);

CREATE OR REPLACE FUNCTION content_flag_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'content_flag is a permanent record'; END IF;
  IF OLD.reviewed_at IS NOT NULL THEN RAISE EXCEPTION 'content_flag already reviewed'; END IF;
  IF (NEW.id, NEW.source, NEW.subject_type, NEW.subject_id, NEW.field, NEW.user_id, NEW.action, NEW.categories, NEW.hits, NEW.excerpt, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.source, OLD.subject_type, OLD.subject_id, OLD.field, OLD.user_id, OLD.action, OLD.categories, OLD.hits, OLD.excerpt, OLD.created_at) THEN
    RAISE EXCEPTION 'content_flag content cannot change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER content_flag_guard_trg BEFORE UPDATE OR DELETE ON content_flag FOR EACH ROW EXECUTE FUNCTION content_flag_guard();
