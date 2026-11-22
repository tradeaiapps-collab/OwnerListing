-- Elena investor onboarding and matching: one preferences row per investor, written by Elena's short question flow.
-- Preferences only. No money, commitment or allocation is stored. The investor can change or delete them at any time.
-- jurisdictions: NULL = not asked yet, empty array = "anywhere in Australia".
CREATE TABLE elena_investor_profile (
  user_id UUID PRIMARY KEY REFERENCES app_user(id),
  budget_max_cents BIGINT CHECK (budget_max_cents BETWEEN 100 AND 1000000000000),
  risk TEXT CHECK (risk IN ('cautious','balanced','growth')),
  jurisdictions TEXT[],
  suburbs TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(suburbs) <= 5),
  timeframe TEXT CHECK (timeframe IN ('under_2y','2_4y','4_plus','flexible')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
