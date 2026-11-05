-- Elena feasibility analyzer: finished projects staff enter as history, and every analysis she has run. Insert only; nothing is deleted.
CREATE TABLE project_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  points INT NOT NULL CHECK (points BETWEEN 1 AND 21),
  weeks INT NOT NULL CHECK (weeks BETWEEN 1 AND 104),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','failed')),
  created_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE feasibility_analysis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  engine TEXT NOT NULL,
  input JSONB NOT NULL,
  result JSONB NOT NULL,
  points INT NOT NULL CHECK (points BETWEEN 1 AND 21),
  success_probability INT NOT NULL CHECK (success_probability BETWEEN 0 AND 100),
  requested_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX feasibility_analysis_created_idx ON feasibility_analysis(created_at DESC);

CREATE OR REPLACE FUNCTION reject_feasibility_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'feasibility records are a permanent record';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER project_history_immutable BEFORE UPDATE OR DELETE ON project_history FOR EACH ROW EXECUTE FUNCTION reject_feasibility_change();
CREATE TRIGGER feasibility_analysis_immutable BEFORE UPDATE OR DELETE ON feasibility_analysis FOR EACH ROW EXECUTE FUNCTION reject_feasibility_change();
