-- Elena's listing assistant: what an author did with each suggestion, so later suggestions fit them.
-- Only fixed vocabulary keys and a length change are stored, never text the author wrote, so there is no personal data here.
CREATE TABLE listing_assistant_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_user(id),
  kind TEXT NOT NULL CHECK (kind IN ('tag','question','rewrite','pricing')),
  key TEXT NOT NULL CHECK (key ~ '^[a-z0-9_]{1,40}$'),
  action TEXT NOT NULL CHECK (action IN ('accepted','dismissed','edited','answered','chosen')),
  delta_pct SMALLINT CHECK (delta_pct BETWEEN -100 AND 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX listing_assistant_feedback_user_idx ON listing_assistant_feedback(user_id, created_at DESC);
