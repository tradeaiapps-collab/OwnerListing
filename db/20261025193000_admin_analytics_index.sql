-- Admin analytics reads "listing.published" events by time; the audit log only had an index by aggregate.
CREATE INDEX IF NOT EXISTS audit_event_type_time_idx ON audit_event (event_type, occurred_at);
