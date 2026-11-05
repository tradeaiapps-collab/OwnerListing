-- Agent workspace: lead pipeline stage per enquiry and a client relationship log. Private to the agent who wrote them.
CREATE TABLE agent_lead_state (
  agent_user_id UUID NOT NULL REFERENCES app_user(id),
  enquiry_id UUID NOT NULL REFERENCES enquiry(id),
  stage TEXT NOT NULL CHECK (stage IN ('new','contacted','viewing','offer','won','lost')),
  follow_up_at DATE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_user_id, enquiry_id)
);

CREATE TABLE agent_crm_note (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_user_id UUID NOT NULL REFERENCES app_user(id),
  buyer_user_id UUID NOT NULL REFERENCES app_user(id),
  kind TEXT NOT NULL CHECK (kind IN ('note','call','email','meeting','preference')),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_crm_note_idx ON agent_crm_note (agent_user_id, buyer_user_id, created_at DESC);
