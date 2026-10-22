-- Business and trust buyers. The ABN is checked on the Australian Business Register, and the person acting
-- must have passed the ID check and shown authority to act for the business.
CREATE TABLE business_buyer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  acting_user_id UUID NOT NULL REFERENCES app_user(id),
  abn CHAR(11) NOT NULL,
  declared_entity_name TEXT NOT NULL,
  register_entity_name TEXT,
  abn_active BOOLEAN,
  authority_document_key TEXT,
  authority_reviewed_by UUID REFERENCES app_user(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  last_checked_at TIMESTAMPTZ,          -- ABN status is re-checked regularly
  UNIQUE (acting_user_id, abn)
);
