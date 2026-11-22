-- Staff can undo a suspension made from the review queue. The item itself stays decided and permanent; the undo is one more history row.
ALTER TABLE moderation_item_event DROP CONSTRAINT IF EXISTS moderation_item_event_action_check;
ALTER TABLE moderation_item_event ADD CONSTRAINT moderation_item_event_action_check CHECK (action IN ('raised', 'approve', 'reject', 'escalate', 'reinstate'));
