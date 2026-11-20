-- Emergency requests join the contractor marketplace: an accepted request carries the JOB- number (from job_number_seq, shared with the job board)
-- and, when it is about one of the requester's own listings, a real job (job_assignment) so chat, visits and reviews work. Open requests widen to further contractors.
ALTER TABLE emergency_request
  ADD COLUMN job_number INTEGER UNIQUE,
  ADD COLUMN assignment_id UUID REFERENCES job_assignment(id),
  ADD COLUMN round SMALLINT NOT NULL DEFAULT 1 CHECK (round BETWEEN 1 AND 3),
  ADD COLUMN last_round_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE emergency_request SET last_round_at = created_at;
