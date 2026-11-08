-- Agent roles: the appointment scope is the most an agent can do; the owner may narrow it to a list of permissions.
-- NULL means everything the scope allows (all existing appointments keep their current access).
-- Offer decisions, contract drafts and auto-reply settings are owner-only and are never a permission.
ALTER TABLE agent_appointment_invite ADD COLUMN permissions TEXT[];
ALTER TABLE listing_agent_appointment ADD COLUMN permissions TEXT[];

ALTER TABLE agent_appointment_invite ADD CONSTRAINT agent_invite_permissions_known CHECK (
  permissions IS NULL OR (cardinality(permissions) > 0 AND permissions <@ ARRAY['enquiries.handle','offer_links.issue','offers.view','listing.describe','listing.publish']::text[])
);
ALTER TABLE listing_agent_appointment ADD CONSTRAINT agent_appointment_permissions_known CHECK (
  permissions IS NULL OR (cardinality(permissions) > 0 AND permissions <@ ARRAY['enquiries.handle','offer_links.issue','offers.view','listing.describe','listing.publish']::text[])
);
-- Publishing stays tied to the full scope, whatever the list says.
ALTER TABLE agent_appointment_invite ADD CONSTRAINT agent_invite_publish_needs_full CHECK (
  permissions IS NULL OR scope = 'full' OR NOT ('listing.publish' = ANY(permissions))
);
ALTER TABLE listing_agent_appointment ADD CONSTRAINT agent_appointment_publish_needs_full CHECK (
  permissions IS NULL OR scope = 'full' OR NOT ('listing.publish' = ANY(permissions))
);
