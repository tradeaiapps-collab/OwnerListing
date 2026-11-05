# Settlement tracker

Tracks an accepted offer through eight stages: offer accepted, deposit received, cooling-off expires, inspection completed, finance approval, lawyer exchange, settlement scheduled, settlement completed.

- Tables (db/20261105260000): `settlement_timeline`, `settlement_milestones`, `settlement_checklists` (items are a JSON array). Never deleted.
- Domain `src/domain/settlement.ts`, DB `src/server/settlement-db.ts`, routes `/api/settlements`, `/api/settlements/[id]`, `/api/staff/settlements`.
- Pages: `/settlements` (buyer, owner, agent), `/settlements/[id]`, `/staff/settlements` (needs report.sales or report.operations).
- Owner or the appointed agent starts it (offer must be accepted) and completes or blocks the open stage. The buyer ticks their own items. Owner and agent tick the solicitors' items.
- Stuck = open stage blocked or open more than 5 days. Cooling-off date is an estimate from STATE_RULES and public holidays (rules not confirmed by counsel).
- Not built: DocuSign, notifications, reminders, payments, lawyer directory, role assignment.
