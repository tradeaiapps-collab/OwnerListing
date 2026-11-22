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

## Elena handles the job (package 2)
Owners switch on "Let Elena handle it" per listing (`/api/listings/<id>/elena-jobs`). Elena offers the job to the best-ranked verified, insured, unsuspended contractor (the normal job offer, source `elena`), chases an unanswered offer (3 reminders, then back to the owner), agrees a time with both sides, writes the agreed time to the job's `scheduled_time`, reminds before the visit, chases the files after it and tells the owner when they arrive. She reads the Jobs page each tick, so acting there or by email gives the same result. Nothing she sends contains a price, contact details or the street address before acceptance; every message is content-checked, limited to 8 a day per person per job, and kept in a permanent log the owner can read. Optional auto-reply (off by default) answers only with a fixed hand-over note, once a day per person. Conversational email replies post to `/api/webhooks/job-reply` (same secret as `job-email`; the forwarder must set `verified` only on a DMARC-aligned pass). Tables: `elena_job_settings`, `elena_job`, `elena_job_message`.

## Certificates and expiry emails
- Contractors upload a licence and an insurance certificate (PDF, JPEG, PNG, WebP or HEIC, up to 10 MB) with the expiry date on it at `/contractor/trust`. API: `GET/POST /api/contractor/certificates`, own file at `/api/contractor/certificates/<id>/file`. Order: real type from the bytes must equal the declared type, malware scan, random storage key `cert/<user>/<random>` (the filename is never stored), daily limit of 10. Fails closed while storage or the scanner is not configured. Nothing is deleted: a newer upload of the same kind supersedes the older one.
- Staff see the files next to the details in the existing queue at `/staff/contractor-trust` (permission `licence.verify`, each file view is audited) with a warning when there is no file or the file's date differs from the typed date. A file does not verify anyone by itself; staff still decide.
- The badge and Elena's matching judge the earlier of the typed date and the file's date (`effectiveDates`, `verifiedInDateSql`), so an expired date takes the badge off and stops auto-invites with no staff action.
- Emails (kinds `cert_expiring`, `cert_expired`, category account, required): 30 days, 7 days and after the date passes, per kind and expiry date, only to staff-verified, active, unsuspended contractors. Sent from the automations tick (`runCertificateExpiryNotices`); the `contractor_expiry_notice` primary key makes every tick safe. A missed stretch sends only the step that applies now. Delivery uses the normal email layer (dev outbox until SES/SMTP is set at `/staff/messaging`).
- Gaps: no OCR of the certificate (staff read it), no retention or deletion path for old files, bulk verify by Elena does not look at files yet, no email to staff when a file is missing.
