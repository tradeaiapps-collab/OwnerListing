-- How a rental bond or deposit is held. The platform never holds it. NULL means not yet confirmed (publish stays blocked for rentals).
ALTER TABLE property_listing
  ADD COLUMN rental_bond_pathway TEXT
  CHECK (rental_bond_pathway IN ('state_bond_authority', 'solicitor_trust', 'bank_guarantee', 'no_bond'));
