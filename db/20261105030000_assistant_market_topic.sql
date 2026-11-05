-- Elena answers suburb market questions (trends, days on market, recent sales) with topic 'market'.
ALTER TABLE enquiry_assistant_turn DROP CONSTRAINT IF EXISTS enquiry_assistant_turn_topic_check;
ALTER TABLE enquiry_assistant_turn ADD CONSTRAINT enquiry_assistant_turn_topic_check
  CHECK (topic IN ('welcome','offer','compromise','settlement','deposit','conditions','listing','market','next_steps','privacy','advice','chitchat','unknown'));
