-- Settlement risk scoring looks up cancelled inspection bookings and completed/cancelled inspections per listing for every open sale.
CREATE INDEX IF NOT EXISTS inspection_booking_cancelled_idx ON inspection_booking(listing_id, buyer_id) WHERE status = 'cancelled';
CREATE INDEX IF NOT EXISTS inspection_listing_requester_idx ON inspection(listing_id, requested_by) WHERE status IN ('completed','cancelled');
