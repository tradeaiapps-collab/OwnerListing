-- Elena scheduling auto-responder: wording templates and the messages Elena drafts for an accepted inspection booking.
-- Elena only suggests. The inspector (the person who accepted the booking) sends, edits or skips each draft; nothing goes to the buyer without that.
-- Decided drafts are kept (draft text, final text, whether it was edited) as the record that Elena suggested them. Nothing is deleted by the application except a template reset.

CREATE TABLE elena_message_template (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = platform-wide (staff), otherwise one agent's own wording.
  owner_user_id UUID REFERENCES app_user(id),
  kind TEXT NOT NULL CHECK (kind IN ('booking_confirmation','reminder_24h')),
  voice TEXT NOT NULL CHECK (voice IN ('professional','casual','friendly','formal')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 20 AND 1500),
  updated_by UUID NOT NULL REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX elena_message_template_own_idx ON elena_message_template(owner_user_id, kind) WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX elena_message_template_global_idx ON elena_message_template(kind) WHERE owner_user_id IS NULL;

CREATE TABLE elena_scheduled_message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES inspection_booking(id),
  kind TEXT NOT NULL CHECK (kind IN ('booking_confirmation','reminder_24h')),
  -- The person who decides (the inspector) and the person it is for (the buyer).
  author_user_id UUID NOT NULL REFERENCES app_user(id),
  recipient_user_id UUID NOT NULL REFERENCES app_user(id),
  draft_body TEXT NOT NULL CHECK (length(draft_body) BETWEEN 1 AND 1500),
  final_body TEXT CHECK (final_body IS NULL OR length(final_body) BETWEEN 1 AND 1500),
  edited BOOLEAN NOT NULL DEFAULT false,
  -- scheduled: waiting for due_at. suggested: waiting for the agent. sent / skipped: decided. expired: the booking was cancelled or the time passed first.
  status TEXT NOT NULL CHECK (status IN ('scheduled','suggested','sent','skipped','expired')),
  due_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  CONSTRAINT elena_scheduled_message_shape CHECK (
    (status = 'sent') = (final_body IS NOT NULL) AND ((status IN ('sent','skipped')) = (decided_at IS NOT NULL))),
  UNIQUE (booking_id, kind)
);
CREATE INDEX elena_scheduled_message_author_idx ON elena_scheduled_message(author_user_id, status, due_at);
CREATE INDEX elena_scheduled_message_due_idx ON elena_scheduled_message(due_at) WHERE status = 'scheduled';

CREATE TRIGGER elena_scheduled_message_no_delete BEFORE DELETE ON elena_scheduled_message FOR EACH ROW EXECUTE FUNCTION inspection_no_delete();
