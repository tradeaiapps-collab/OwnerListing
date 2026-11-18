-- One staff review queue for listings, messages and profiles. Any filter or report feeds it through enqueueModerationItemPg;
-- staff approve, reject or escalate. Items and their decision history are permanent.
CREATE TABLE moderation_item (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type     TEXT NOT NULL CHECK (subject_type IN ('listing', 'message', 'profile')),
  subject_id       UUID NOT NULL,
  subject_label    TEXT NOT NULL CHECK (char_length(subject_label) BETWEEN 1 AND 200),
  subject_owner_id UUID REFERENCES app_user(id),
  source           TEXT NOT NULL CHECK (char_length(source) BETWEEN 1 AND 60),
  reason           TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 120),
  detail           TEXT CHECK (detail IS NULL OR char_length(detail) <= 1000),
  severity         TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'escalated', 'approved', 'rejected')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by       UUID REFERENCES app_user(id),
  decided_at       TIMESTAMPTZ,
  decision_note    TEXT,
  CHECK ((status IN ('approved', 'rejected')) = (decided_at IS NOT NULL)),
  CHECK (decided_by IS NULL OR subject_owner_id IS NULL OR decided_by <> subject_owner_id)
);
-- The same problem on the same subject from the same source is one open item, however many times it is raised.
CREATE UNIQUE INDEX moderation_item_dedupe_idx ON moderation_item (subject_type, subject_id, source, reason) WHERE status IN ('open', 'escalated');
CREATE INDEX moderation_item_queue_idx ON moderation_item (status, created_at);

CREATE TABLE moderation_item_event (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id    UUID NOT NULL REFERENCES moderation_item(id),
  actor_id   UUID REFERENCES app_user(id),
  action     TEXT NOT NULL CHECK (action IN ('raised', 'approve', 'reject', 'escalate')),
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX moderation_item_event_item_idx ON moderation_item_event (item_id, created_at);

CREATE OR REPLACE FUNCTION moderation_rows_permanent() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '% rows are permanent', TG_TABLE_NAME; END IF;
  IF TG_TABLE_NAME = 'moderation_item_event' THEN RAISE EXCEPTION 'moderation_item_event rows are permanent'; END IF;
  IF OLD.status IN ('approved', 'rejected') THEN RAISE EXCEPTION 'moderation_item is already decided'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER moderation_item_guard BEFORE UPDATE OR DELETE ON moderation_item FOR EACH ROW EXECUTE FUNCTION moderation_rows_permanent();
CREATE TRIGGER moderation_item_event_guard BEFORE UPDATE OR DELETE ON moderation_item_event FOR EACH ROW EXECUTE FUNCTION moderation_rows_permanent();
