-- Staff automation: workflow rules, bulk email/SMS campaigns and scheduled tasks.
--   automation_rule / automation_run  "when X happens, do Y". One run row per rule and event (unique key), so an event never fires a rule twice.
--   listing_view                      signed-in buyer views of a published listing (feeds the "viewed N times" trigger).
--   campaign / campaign_recipient     a message to a segment, sent in batches. Recipients are fixed (snapshotted) when sending starts.
--   scheduled_task / scheduled_task_run  bulk actions that run at a set time (once, daily, weekly, monthly).
CREATE TABLE automation_rule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 3 AND 120),
  enabled BOOLEAN NOT NULL DEFAULT true,
  trigger TEXT NOT NULL CHECK (trigger IN ('offer_received','listing_aging','listing_viewed_repeat')),
  trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  recipient TEXT NOT NULL CHECK (recipient IN ('owner','agent','buyer','owner_and_agent')),
  message_kind TEXT NOT NULL CHECK (message_kind IN ('system_notice','marketing_news')),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 400),
  link TEXT CHECK (link IS NULL OR (link LIKE '/%' AND link NOT LIKE '//%' AND char_length(link) <= 300)),
  created_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_fired_at TIMESTAMPTZ
);
CREATE INDEX automation_rule_trigger_idx ON automation_rule (trigger) WHERE enabled;

CREATE TABLE automation_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES automation_rule(id),
  event_key TEXT NOT NULL CHECK (char_length(event_key) <= 200),
  listing_id UUID REFERENCES property_listing(id),
  recipients INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rule_id, event_key)
);
CREATE INDEX automation_run_rule_idx ON automation_run (rule_id, created_at DESC);

CREATE TABLE listing_view (
  id BIGSERIAL PRIMARY KEY,
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  viewer_user_id UUID NOT NULL REFERENCES app_user(id),
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX listing_view_idx ON listing_view (listing_id, viewer_user_id, viewed_at DESC);

CREATE TABLE campaign (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 3 AND 120),
  channel TEXT NOT NULL CHECK (channel IN ('email','sms')),
  segment TEXT NOT NULL CHECK (segment IN ('all_agents','all_owners','all_buyers','buyers_in_area')),
  segment_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  subject TEXT CHECK (subject IS NULL OR char_length(subject) BETWEEN 1 AND 150),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1500),
  cta_url TEXT CHECK (cta_url IS NULL OR (cta_url ~ '^https://[^\s]{1,250}$' OR (cta_url LIKE '/%' AND cta_url NOT LIKE '//%' AND char_length(cta_url) <= 300))),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','cancelled')),
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (channel = 'sms' OR subject IS NOT NULL),
  CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL)
);
CREATE INDEX campaign_due_idx ON campaign (scheduled_at) WHERE status IN ('scheduled','sending');

CREATE TABLE campaign_recipient (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaign(id),
  user_id UUID NOT NULL REFERENCES app_user(id),
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  sent_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  open_count INT NOT NULL DEFAULT 0,
  click_count INT NOT NULL DEFAULT 0,
  UNIQUE (campaign_id, user_id)
);
CREATE INDEX campaign_recipient_pending_idx ON campaign_recipient (campaign_id) WHERE status = 'pending';

CREATE TABLE scheduled_task (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 3 AND 120),
  kind TEXT NOT NULL CHECK (kind IN ('archive_stale_listings','invite_reminders','platform_summary')),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  cadence TEXT NOT NULL CHECK (cadence IN ('once','daily','weekly','monthly')),
  hour INT NOT NULL DEFAULT 9 CHECK (hour BETWEEN 0 AND 23),
  weekday INT CHECK (weekday BETWEEN 1 AND 7),
  day_of_month INT CHECK (day_of_month BETWEEN 1 AND 28),
  run_at TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_status TEXT CHECK (last_status IS NULL OR last_status IN ('ok','failed')),
  last_detail TEXT,
  created_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_task_due_idx ON scheduled_task (next_run_at) WHERE enabled AND next_run_at IS NOT NULL;

CREATE TABLE scheduled_task_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES scheduled_task(id),
  started_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','failed')),
  affected INT NOT NULL DEFAULT 0,
  detail TEXT,
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('schedule','manual'))
);
CREATE INDEX scheduled_task_run_idx ON scheduled_task_run (task_id, started_at DESC);
