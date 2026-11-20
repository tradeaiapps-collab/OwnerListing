# Contractor marketplace (package 1)

Contractors (photographer, building inspector, pest control, other trades) have a public page, set their own prices, get job offers and answer them. Owners pay contractors directly; the platform takes no payment for jobs.

- Numbers: contractors are CON-2001 and up (`contractor_number_seq`), jobs are JOB-5001 and up (`job_number_seq`). The job number is in every job notification title, so in every email subject.
- Pages: `/contractors` (search by trade, suburb or postcode, name; "Let Elena choose"), `/contractors/<2001>` (public page, aggregate job figures, services with prices, gallery, feedback, Book), `/contractor/profile` (own page, figures, services, gallery, service areas), `/contractor/jobs` and `/jobs` (offers and jobs), `/jobs/<id>` (job page, upload, review).
- API: `/api/contractor-page`, `/api/contractors`, `/api/contractors/<no>`, `/api/jobs`, `/api/jobs/<id>` (GET, POST action), `/api/jobs/<id>/review`, `/api/listings/<id>/jobs` (book), `.../jobs/suggest`, `.../jobs/elena`, `/api/webhooks/job-email`.
- Code: `src/domain/contractor-market.ts` (numbers, validation, stats, ranking), `src/domain/job-board.ts` (book, Elena, actions, review), `src/domain/job-inbound.ts` (email matching), `src/server/contractor-market-db.ts` (SQL), migration `db/20261120000000_contractor_marketplace.sql`.
- Job flow: owner books (offer, status `proposed`) -> contractor accepts, rejects with a reason, or proposes another time -> owner accepts or declines the time (accepting a time also accepts the job) -> contractor uploads and marks done -> owner confirms complete -> owner leaves one rating and feedback. Existing `respondToAssignment` still does accept, decline, cancel, complete.
- Stats (public page shows aggregates, own page adds waiting count): received, accepted (ever approved), rejected (contractor declined), completed, completion rate (completed / accepted), average response time (offer to accept or reject), jobs this month, rating.
- Verified badge: shows only when `contractor_page.licence_verified_at` is set. Nothing sets it yet (staff check screen is not built). Changing the licence number or state clears it.

## Files by email (reply with the job number)

A contractor replies to a job email, or sends a new one, with `JOB-5001` in the subject or text and the files attached, from the address on their account. `processJobEmail` finds the job by number AND sender address, needs the job accepted, checks the real file type, runs the normal upload service (type, size, malware scan, storage, "parties only" visibility), attaches to the listing, notifies the owner, and the webhook emails a short result back.

What you must set up (nothing is received until you do):
1. `JOB_EMAIL_INBOUND_SECRET` (32+ random characters) in the environment. Unset, the endpoint answers 503.
2. An inbound email provider that receives mail at an address such as `jobs@your-domain` and POSTs JSON to `https://<site>/api/webhooks/job-email` with header `x-inbound-secret`. Body: `{ "from", "subject", "text", "headers"?, "attachments": [{ "filename", "contentType", "contentBase64" }] }`. Amazon SES receiving (S3 + a small Lambda) or SendGrid/Mailgun inbound parse both fit; a Lambda or forwarder converts their format. The provider must reject mail that fails SPF/DKIM, because the sender address is part of the match.
3. Set the outbound "reply-to" of job emails to that address (not done yet, see the handoff) so a plain reply carries the job number back.
4. Storage and the malware scanner must be configured (same as website uploads), or files are refused and the sender is told.
Until then contractors upload on the job page, which uses the same checks.

## Limits and known gaps
- Gallery photos and videos are https links, not uploads.
- Vendor-type accounts cannot sign in (no vendor role in `roles.ts`); contractors use agent-type accounts today. A proper contractor sign-up is still needed.
- Elena "choose for me" only sends the first offer. Reminders, time negotiation, chasing uploads and email reading are package 2.
