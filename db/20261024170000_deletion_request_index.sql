-- Per-user rate limit and open-request cap on document_deletion_request (security review 2026-10, finding 1).
-- The guard counts one requester's rows on every request, so index them. Index only: the table stays insert-only.
CREATE INDEX IF NOT EXISTS document_deletion_request_by_user
  ON document_deletion_request (requested_by, requested_at);
