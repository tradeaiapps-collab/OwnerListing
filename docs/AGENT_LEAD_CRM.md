# Agent buyer-lead CRM

Agents see everyone who enquired about, asked to view, or asked to inspect a listing they are appointed to, at `/agent/leads` (detail: `/agent/leads/[id]`). API: `/api/agent/crm-leads` (the bare `/api/agent/leads` belongs to Elena's qualifier; ad leads are `ad_lead*`).

- **Capture is in Postgres triggers** (`db/20261105270000_agent_leads.sql`) on `enquiry`, `enquiry_message`, `viewing_booking` (kind viewing), `inspection_booking` and `formal_offer`, so every code path is covered. Lead = one per (listing, appointed agent, buyer). No appointed agent, or an appointment without `enquiries.handle`, means no lead.
- **Status** only moves forward (new_inquiry, viewing_scheduled, offer_pending). A buyer returning reopens a lost lead. `converted` is set only when the owner accepts that buyer's offer. Agents mark `lost` with a reason (budget, location, other).
- **Offers never create a lead** (the platform hides the buyer from the seller side of an offer); they only move a lead the agent already had.
- **Colour**: red = no reply yet or follow-up overdue, yellow = buyer wrote since the agent's last reply, green = agent has the last word.
- **Response time** = lead created to the agent's first message in the enquiry thread.
- **Visibility**: a lead shows only while the agent's appointment is active; revoking hides it (rows are kept).
- **Reminders**: agent picks 1/2/3/7/14 days; `POST /api/internal/crm-leads/reminders` (header `x-cron-secret`, env `CRM_LEAD_CRON_SECRET`, 32+ chars) notifies once per due follow-up. `.github/workflows/crm-lead-reminders.yml` calls it hourly using repository secrets `APP_URL` and `CRM_LEAD_CRON_SECRET`.

Not built yet: analytics, bulk actions, snooze, listing-view notes, lead scoring/auto-assignment, email templates, SMS.
