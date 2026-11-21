# Elena for rentals

Elena helps rental owners with three things. She summarises and flags; the owner decides. She never accepts or declines an applicant, never agrees a price and never moves money. Reuses Elena's content filter, per-person rate limit and fixed-wording messages from the job autopilot (`src/domain/elena-jobs.ts`), the job flow (`bookContractor`), the emergency flow (`submitUrgentRequest`) and the tenant entry notice from contractor operations.

Code: `src/domain/elena-rentals.ts` (pure rules), `src/server/elena-rentals-db.ts` (storage, actions, scheduler tick), `db/20261120180000_elena_rentals.sql`. Screens: `/listings/[id]/rentals` (owner desk), `/listings/[id]/apply`, `/rentals` (renter and tenant). Switches live on the desk; automatic offers and automatic emergencies are off by default.

## 1. Application screening
Four criteria only: rent as a share of stated weekly income, months of rental history, number of references, move-in window. Each is shown as Met, Not met, Not provided or Not asked with a plain reason. Missing facts are asked for (at most twice, two days apart). No rental history shows as "not provided", never as a failure. Ranking: fewest not met, most met, fewest not provided, then who applied first. The applicant's note is never scored; it is withheld from the owner when it names a protected attribute or contact details. Decisions (`shortlist`, `approve`, `decline`) are the owner's alone and audited; a decline sends a neutral message with no reason.

## 2. Viewings
Owner adds times (capacity 1 to 6). Elena offers the next three free times to applicants who have not booked, books on the applicant's pick (slot row locked, so no overbooking; booking again moves it), confirms to both, reminds 24 h and 2 h before, and sends the owner one summary after each slot. Cancelling a time tells the people booked on it.

## 3. Repairs
A tenant (made a tenant by the owner) reports a problem with up to 3 photos (stored privately, visible to the tenant, owner and the contractor only after accepting). Elena triages by fixed rules: emergency, urgent, routine. Emergencies tell the tenant to call 000 / leave first and alert the owner at once; they go to emergency contractors only when the owner presses the button or switched automatic emergencies on. Otherwise Elena proposes the best verified, insured, unsuspended contractor (trade "other") and the owner approves, which creates a normal job offer with no price; with automatic offers on she sends it herself (never for emergencies). She nudges the owner (1 h / 6 h / 24 h by urgency, three times, then stops), tells the tenant and owner when a visit is booked, sends the tenant an entry notice (visits under 24 h away wait for the tenant's yes), checks with the tenant after the visit and closes only when the tenant says it is fixed.

## Setup on the PC
Run the new migration. The scheduler tick is the existing `/api/internal/automations/run` call (now also runs rental repairs, reminders and summaries). Email for entry notices uses the existing email port.

## Not done
Appointed agents cannot approve repairs (owner only); the visit time is read from the job (a later change by the contractor is not re-noticed); no SMS-specific wording; applicant income evidence is the owner's to ask for.

## Known residual risks

- Applicant data retention: `/staff/applicant-retention` (config.edit) sets a period of 90 to 3650 days (default 365, automatic purge off until switched on). A purge, by staff or the daily automation tick, scrubs income, history, references, move-in date and note on rental applications, and the draft text and topics of Elena's enquiry actions, older than the period; rows, statuses and the audit trail stay, and every run is audited with counts only. Chat and Elena message records are never deletable and are not touched, so counsel should decide whether their wording needs a separate rule. The period itself is still for counsel to set before real applicants.
- Tenant free text in a repair report goes to contractors before they accept the job. The tenant form says so.
- The applicant-note filter is a pattern list and can miss paraphrases. The owner desk carries a banner, and notes are never scored.
- Messages that are not sent (blocked by the filter or rate limit) are still logged in `rental_message` without a cap.
- A tenant can self-declare an emergency. This only dispatches automatically if the owner turned on `auto_emergency` (off by default). Reports are rate limited.
- Repair photo upload needs a declared Content-Length (411 if missing, 413 over 8 MB, at most 4 photos).

## Privacy rules added after security review

- The street address is shown to an applicant (page and messages) only once they are shortlisted, approved or have a booked viewing. Before that, only the suburb and postcode. The apply endpoint never returns the street address.
- The owner sees "Applicant N" and no free-text note until they shortlist the applicant. Viewing messages and summaries to the owner use the same label.
- Automatic emergency dispatch needs a fixed safety rule (gas, fire, flooding and so on) to match the description. A tenant's own emergency tick still alerts the owner at once, but the owner presses the button.
- Approving a repair re-checks that the proposed contractor is still verified, insured and not suspended.
- Repair photos are metadata-stripped (EXIF/GPS) and malware scanned like other uploads. With no scanner configured, photos are refused and the report can be sent without them.
