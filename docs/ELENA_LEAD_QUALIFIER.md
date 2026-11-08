# Elena lead qualifier

Elena talks to a prospect (buyer, seller, tenant or landlord) on chat, SMS or email, works out how ready they are, scores them 0 to 100 and routes them to the best licensed agent. She is always introduced as an AI assistant, never accepts or promises anything, and passes the lead to a person. Off until `LEAD_QUALIFIER=on`.

## How it works
- **Conversation** (`src/domain/lead-qualifier.ts`): rules read answers into slots (goal, place, timeline, budget, property type, motivation, finance, contact). A message can fill several slots at once. If the rules find nothing for the question just asked, the self-hosted model (when on) is asked for JSON, and every key is validated. Rules always win. A question that is not answered is asked once more in other words, then dropped; goal and place are never dropped (after three tries Elena offers a team member). "Talk to a person" hands over at once (asking only for the area if missing). STOP ends it and she stays silent.
- **Score** (0-100): timeline 25, budget 20, place 15, property type 10, motivation 10, finance 10 (buyers only), contact 10. Weights are renormalised for the parts that apply. Tiers: hot 70+, warm 40-69, cold below 40. Only budget, timing, place, property and readiness are scored: never a name, age, family, ethnicity or religion.
- **Routing** (`src/domain/lead-routing.ts`): needs a postcode (state comes from it). Eligible agents are accepting, hold a verified unexpired licence for that state, cover the area (or stated no areas), take that kind of work (sale or rent, residential or commercial) and have fewer than 25 open leads. Points: area 40, work type 15, property type 10, spare capacity 15, track record 20 (smoothed conversion rate; counts fully for hot leads, half for cold). The result carries plain-language reasons and two alternatives. Cold leads are nurtured, not routed, unless they ask for a person. Nothing eligible: the lead waits in the staff queue.
- **Follow-ups**: agent first-contact deadline 4h (hot), 24h (warm), 72h (cold); a missed one adds a note for staff. Elena checks in at most twice (unfinished chat: 2 hours then 2 days; finished cold lead: 7 then 21 days), only on SMS or email, only to someone who wrote first, 8am to 8pm local time, never after STOP.
- **Learning** (`src/domain/lead-learning.ts`): agents record `converted`, `lost` or `unresponsive`. Staff run "propose": it measures which answers predict conversion and which questions end chats, then saves a new config version (score weights and question order) **inactive**. Nothing changes under 30 results, each weight moves at most 50% from default and is softened by sample size, goal and place always stay first, and staff must activate a version. Chats that died before routing feed question drop-off only.
- **Notes**: Elena writes a summary note on every routed lead; agents and staff add notes (50 per lead).

## Channels
| Channel | Entry | Reply |
|---|---|---|
| Chat | `POST /api/leads/chat` `{message, token?}` (public; token returned on first call, only its hash is stored; 10 new conversations per origin per hour) | in the response |
| SMS | existing Twilio inbound webhook (`/api/webhooks/twilio/inbound`) when `LEAD_QUALIFIER=on` | TwiML reply |
| Email | `POST /api/webhooks/email-inbound` with header `x-inbound-secret`, body `{from, text, headers?}` (from a mail provider's inbound parse); robots and no-reply senders are ignored | email via the messaging port |

## API
Agent: `GET /api/agent/leads`, `GET /api/agent/leads/:id` (contact details and transcript, assigned agent only), `POST /api/agent/leads/:id` `{action: contact | note | result}`. Staff: `GET /api/staff/leads` (unrouted, `report.sales`), `POST /api/staff/leads` `{leadId, agentUserId}` (`user.manage`), `GET|POST /api/staff/leads/config` (`{action: propose | activate, version}`). Job: `POST /api/internal/leads/followups`.

## Deploy
1. `npm run migrate` (adds `lead`, `lead_turn`, `lead_assignment`, `lead_note`, `lead_followup`, `lead_qualifier_config`).
2. Set `LEAD_QUALIFIER=on`, `LEAD_CRON_SECRET` (32+ chars) and, for email, `LEAD_EMAIL_INBOUND_SECRET`. SMS needs the Twilio webhook already set up (see the SMS docs).
3. Add repository secret `LEAD_CRON_SECRET` (same value) next to `APP_URL`; `.github/workflows/lead-followups.yml` runs every 15 minutes.
4. Agents fill in their profile (areas, work type) at `/api/agent/profile`; without it they are treated as generalists.
5. Counsel check before turning on SMS or email check-ins: Spam Act consent wording, and the retention period below.

## Privacy
Contact details are shared only with the assigned agent and staff. Conversation text is deleted 180 days after a lead closes (notes and results stay). Anonymous chat stores a hash of the token and a hash of the network origin, never the raw address.

## Not built yet
A screen for agents and staff (the API is ready), a chat widget on the public site, email attachments, voice calls, and editing the weights by hand.
