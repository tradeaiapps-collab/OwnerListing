# Automation (workflows and campaigns)

Agents and owners build workflows at `/agent/automations`: **when** an event happens on a listing they manage, **if** it matches a filter, run **steps**.

## Triggers
| Trigger | Fires when | Hook |
|---|---|---|
| `new_lead` | a buyer's enquiry is saved | `app/api/listings/[id]/enquiries` |
| `property_listed` | a listing is published (not on dry run) | `app/api/listings/[id]/publish` |
| `offer_received` | a formal offer is submitted | `app/api/listings/[id]/offers` |
| `inspection_complete` | an inspector completes an inspection | `app/api/inspections/[id]` |

Hooks call `fireAutomation(db, event)` (src/server/automation-db.ts). It never throws and is idempotent: one run per workflow per event (`UNIQUE (workflow_id, subject_key)`). Facts are read from the database; nothing comes from the request. Only listing facts and the contact's first name are used.

## Steps (src/domain/automation.ts, pure)
- **send**: email, SMS or in-app, to the contact or to the owner. Merge fields `{{listing_title}}` etc. (only those the trigger provides).
- **wait**: 1 minute to 30 days (60 days total per workflow).
- **branch**: condition group (all/any; is, is not, more than, at least, less than, at most, contains, does not contain) choosing the next step. Branches only jump forward or to "end", so loops are impossible.
- **stop**.

Limits: 20 steps, 10 conditions per group, 25 workflows per owner.

## State machine and delivery
Run status: `running` -> `waiting` -> `completed` | `stopped` | `failed`. `advance()` runs steps until a wait, stop or end and returns send actions. The server saves the new position and a `pending` log row first, then sends, then sets the row to `sent`/`skipped`/`failed`, so a crash can lose a message but never double it. Runs keep a copy of the workflow as it was when they started; edits affect new runs only.

A scheduler calls `POST /api/internal/automations/run` (header `x-cron-secret`, env `AUTOMATION_CRON_SECRET`, 32+ chars, else 503) every 10 minutes (`.github/workflows/automation-runs.yml`, repository secrets `APP_URL` and `AUTOMATION_CRON_SECRET`). Due runs are claimed with `FOR UPDATE SKIP LOCKED` and a 10-minute lease.

## Messaging rules (important)
Sends go through `notifyUser`, so the recipient's own preferences, quiet hours, rate limits and unsubscribe links apply.
- To the contact: kind `automation_message`, category **marketing** (opt-in, off by default, unsubscribe link required). Never SMS (not allowed for marketing). A contact who has not opted in is logged as `skipped`.
- To the owner: kind `automation_alert`, category messages (SMS only if the owner opted in and verified a phone).
- The recipient is derived from the event, never typed into a workflow.
- Workflows are created switched off; owners test (dry run, nothing sent) then turn on. Paused workflows hold their runs; archived ones stop them. Nothing is deleted.

## Activity log
`automation_log` is insert-only (the only allowed update moves a send row off `pending`). Shown per workflow in the builder.

## Not built yet
Stopping a campaign when the buyer replies or makes an offer (needs live conditions), per-step A/B, merge fields beyond listing facts, contact SMS (needs consent capture), a listing-level "all campaigns" view.
