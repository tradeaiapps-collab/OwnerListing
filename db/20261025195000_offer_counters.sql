-- Counter-offers: the back-and-forth after a buyer's formal offer. formal_offer keeps the buyer's original terms; each
-- counter is one side's proposed terms. A counter's terms are never edited: only its status and closed_at change, once.
ALTER TABLE formal_offer DROP CONSTRAINT formal_offer_status_check;
ALTER TABLE formal_offer ADD CONSTRAINT formal_offer_status_check
  CHECK (status IN ('submitted','under_review','countered','buyer_countered','accepted','rejected','withdrawn','expired'));

CREATE TABLE offer_counter (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id UUID NOT NULL REFERENCES formal_offer(id),
  round SMALLINT NOT NULL CHECK (round BETWEEN 1 AND 10),
  from_party TEXT NOT NULL CHECK (from_party IN ('owner','buyer')),
  created_by UUID NOT NULL REFERENCES app_user(id),
  price_cents BIGINT NOT NULL CHECK (price_cents > 0),
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  settlement_days INTEGER NOT NULL CHECK (settlement_days BETWEEN 1 AND 365),
  deposit_cents BIGINT NOT NULL CHECK (deposit_cents >= 0 AND deposit_cents <= price_cents),
  -- open: waiting for the other side. agreed: the buyer agreed to the owner's counter (the owner still accepts).
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','agreed','countered','accepted','rejected','withdrawn','expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK (status <> 'agreed' OR from_party = 'owner'),
  UNIQUE (offer_id, round),
  -- At most one counter waits for an answer at a time. Checked at the end of each statement, so one statement can close
  -- the old counter and open the new one.
  CONSTRAINT offer_counter_one_open EXCLUDE USING btree (offer_id WITH =) WHERE (status = 'open') DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX offer_counter_open_expiry_idx ON offer_counter(expires_at) WHERE status = 'open';

-- The counter whose terms were accepted. NULL on an accepted offer means the buyer's original terms.
ALTER TABLE formal_offer ADD COLUMN accepted_counter_id UUID REFERENCES offer_counter(id);
CREATE INDEX formal_offer_buyer_idx ON formal_offer(buyer_user_id, submitted_at);
