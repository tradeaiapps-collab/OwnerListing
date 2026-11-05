# Client portal

Buyers, owners and agents get one page, `/client/portal`, for their own documents, viewings and messages. Vendors (inspectors and other providers) are refused; they have their job screens.

## What is in it
| Tab | Source | Who sees what |
|---|---|---|
| Documents | offers, completed inspection reports, completed signed documents | Offer: the buyer who made it and the owner of its listing (owner copy never names the buyer). Report: its manager, its inspector, and anyone it is shared with (completed reports only). Signed copy: its signers and the listing owner. |
| Viewings | `viewing_booking` | The requester and the listing's owner or full-scope agent. |
| Messages | existing enquiry threads | Same rules as `/enquiries`; the portal lists threads and links to them. |

## API (all JSON, all `withApi`, cookie or phone-app bearer session)
- `GET /api/client/portal` returns `{ documents, bookings, threads, role }` for the signed-in user only.
- `GET /api/client/portal/documents/offer/:id` and `.../inspection/:id` download a PDF attachment (`nosniff`, `no-store`, sandbox CSP). Anyone not entitled gets 404, the same as a missing document. Signed copies keep `GET /api/signing-documents/:id/pdf`.
- `POST /api/client/portal/bookings` with `{ listingId, kind: "viewing" | "consultation", startsAt, note? }`. The listing must be published and not the requester's own; the time must be 1 hour to 90 days ahead; at most 20 open requests per person.
- `POST /api/client/portal/bookings/:id` with `{ action }`: `cancel` by the requester (from requested or confirmed), `confirm` or `decline` by the listing manager (from requested). Nothing is deleted; every change writes an `audit_event` row.

## Security notes
Every query takes the user id from the session, never from the request. The booking table refuses DELETE with a trigger. PDFs are built in-process from stored records (no user HTML, no file paths). Security review applies (personal data and permissions).

## Deploy
1. Run `npm run migrate` (adds `db/20261105200000_viewing_booking.sql`; no data changes, rollback is `DROP TABLE viewing_booking` while empty).
2. No new environment variables, providers or cron jobs.
3. Smoke test: sign in as a buyer with an offer, open `/client/portal`, download the offer PDF, request a viewing from a listing's "Book a viewing" button, then confirm it as the owner.

## Not yet in this release
Listing analytics for owners (use `/reports`), email/push notice to the owner on a new booking request, agent access to offer PDFs, rescheduling, and in-portal chat (the portal links to the enquiry thread).
