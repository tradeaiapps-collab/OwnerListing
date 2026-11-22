-- Agent marketplace: public agent profiles, weekly availability, consultation bookings, reviews and a portfolio.
-- An agent is listed only if they switch it on. Reviews need a real consultation or enquiry on a listing the agent was appointed to.
ALTER TABLE agent_profile
  ADD COLUMN listed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN headline TEXT NOT NULL DEFAULT '' CHECK (char_length(headline) <= 120),
  ADD COLUMN photo_url TEXT CHECK (photo_url IS NULL OR (photo_url ~ '^https://' AND char_length(photo_url) <= 500)),
  ADD COLUMN specialties TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(specialties) <= 12),
  ADD COLUMN languages TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(languages) <= 8),
  ADD COLUMN years_experience INT CHECK (years_experience IS NULL OR years_experience BETWEEN 0 AND 60),
  ADD COLUMN consult_modes TEXT[] NOT NULL DEFAULT '{}' CHECK (consult_modes <@ ARRAY['video','phone']::text[]),
  ADD COLUMN consult_minutes INT NOT NULL DEFAULT 30 CHECK (consult_minutes IN (15, 30, 45, 60)),
  ADD COLUMN video_url TEXT CHECK (video_url IS NULL OR (video_url ~ '^https://' AND char_length(video_url) <= 500)),
  ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Australia/Brisbane';
CREATE INDEX agent_profile_listed_idx ON agent_profile(listed) WHERE listed;

-- Weekly hours in the agent's timezone. weekday 0 = Sunday. Minutes from midnight.
CREATE TABLE agent_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_user_id UUID NOT NULL REFERENCES app_user(id),
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min INT NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min INT NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  CHECK (end_min > start_min)
);
CREATE INDEX agent_availability_agent_idx ON agent_availability(agent_user_id);

CREATE TABLE agent_consultation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_user_id UUID NOT NULL REFERENCES app_user(id),
  client_user_id UUID NOT NULL REFERENCES app_user(id),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('video','phone')),
  client_phone TEXT CHECK (client_phone IS NULL OR char_length(client_phone) <= 30),
  note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  cancelled_by UUID REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
-- The database refuses two live bookings for the same agent at the same start, so a race cannot double-book.
CREATE UNIQUE INDEX agent_consultation_slot_idx ON agent_consultation(agent_user_id, starts_at) WHERE status = 'confirmed';
CREATE INDEX agent_consultation_client_idx ON agent_consultation(client_user_id, starts_at DESC);
CREATE INDEX agent_consultation_agent_idx ON agent_consultation(agent_user_id, starts_at DESC);

CREATE TABLE agent_review (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_user_id UUID NOT NULL REFERENCES app_user(id),
  reviewer_user_id UUID NOT NULL REFERENCES app_user(id),
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT NOT NULL DEFAULT '' CHECK (char_length(title) <= 80),
  body TEXT NOT NULL DEFAULT '' CHECK (char_length(body) <= 1500),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (agent_user_id <> reviewer_user_id),
  UNIQUE (agent_user_id, reviewer_user_id)
);
CREATE INDEX agent_review_agent_idx ON agent_review(agent_user_id, created_at DESC) WHERE status = 'published';

-- Agent-entered portfolio items (sales from before the platform). Platform sales are read from accepted offers, not stored here.
CREATE TABLE agent_portfolio_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_user_id UUID NOT NULL REFERENCES app_user(id),
  suburb TEXT NOT NULL CHECK (char_length(suburb) BETWEEN 1 AND 80),
  property_type TEXT NOT NULL DEFAULT 'house' CHECK (char_length(property_type) <= 30),
  sold_on DATE NOT NULL,
  price_cents BIGINT CHECK (price_cents IS NULL OR price_cents > 0),
  note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_portfolio_agent_idx ON agent_portfolio_item(agent_user_id, sold_on DESC);
