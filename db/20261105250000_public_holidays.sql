-- Public holidays by state, left out when cooling-off business days are counted (sale fell through).
-- Maintained by staff at /staff/public-holidays; a change is audited. A date appears once per state.
CREATE TABLE public_holiday (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL CHECK (state IN ('NSW','VIC','QLD','SA','WA','TAS','ACT','NT')),
  holiday_date DATE NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  created_by UUID REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (state, holiday_date)
);
