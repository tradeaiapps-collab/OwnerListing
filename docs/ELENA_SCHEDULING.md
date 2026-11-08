# Elena scheduling auto-responder

When an inspector accepts a booking, Elena drafts a **booking confirmation** (offered at once) and a **24-hour reminder** (offered 24h before; skipped if the visit is under 24h away). Elena only suggests: the inspector sends, edits or skips at `/inspector/messages`. Sending delivers the text to the buyer as an in-app notification (`scheduling_message`, messages category, so the buyer's own channel settings apply). No new sending channel.

- Domain (pure): `src/domain/elena-scheduling.ts` (kinds, 4 voices, built-in templates, `[variables]`, rendering, planning, decision parsing). Server: `src/server/elena-scheduling-db.ts`. Migration `20261105270000_elena_scheduling.sql`.
- Template order: agent's own, then platform-wide (`/staff/scheduling-templates`, permission `scheduling_template.manage`), then built-in friendly text. Variables: `[buyer_name] [agent_name] [property_address] [appointment_time] [listing_title] [buyer_notes]`; unknown ones are rejected on save.
- Record: `elena_scheduled_message` keeps the draft, the final text and `edited`; rows are never deleted. Decisions write an audit event.
- Hook: `POST /api/inspector/requests/[id]` (accept) calls `draftBookingMessages` (never throws). Due reminders and expiry run inside the existing automation cron tick (`/api/internal/automations/run`), so no new secret or workflow.
- Not built: SMS/email sending, 1-hour reminder, post-inspection follow-ups, multi-language, tone adaptation, learning, A/B. Parking info is not in listing data, so it appears only if a template includes it.
