-- Agent performance: sale-verified buyer ratings and owners' favourite agents. Metrics themselves (time to sale, velocity, price achieved,
-- fall-through rate) are computed from formal_offer and the appointment history, so there is no cache table yet.

-- A buyer whose offer on a listing was accepted rates the agent who held the listing at that time. The buyer's id is stored for the
-- one-rating-per-sale rule and is never returned by any read; owners and agents see only the rating, comment and month.
CREATE TABLE agent_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES app_user(id),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  buyer_id UUID NOT NULL REFERENCES app_user(id),
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '' CHECK (char_length(comment) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (agent_id <> buyer_id),
  UNIQUE (listing_id, buyer_id)
);
CREATE INDEX agent_ratings_agent_idx ON agent_ratings(agent_id, created_at DESC);

CREATE TABLE agent_favorite (
  owner_id UUID NOT NULL REFERENCES app_user(id),
  agent_id UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, agent_id),
  CHECK (owner_id <> agent_id)
);
