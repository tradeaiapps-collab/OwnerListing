# Buyer pre-approvals

Buyers upload a lender's pre-approval PDF; Elena (rule based, `src/domain/prequalification.ts`) reads amount, rate, term, expiry and conditions; staff confirm; sellers see a short verified summary beside each offer.

- Tables (`db/20261105260000_buyer_prequalification.sql`): `buyer_prequalifications` (status pending_review / verified / resubmit_requested / expired), insert-only `prequalification_summaries`.
- Confidence: worst of amount vs price (100% / 90%), conditions (routine only / other / onerous or 4+), validity (>90 / 30-90 / <30 days). No price to compare skips the amount check.
- Expiry is derived on read (`effectiveStatus`); no job yet.
- Buyer: `/buyer/prequalification`, `GET/POST /api/buyer/prequalifications` (buyer accounts, PDF only, 10 MB, 10 per day, scanner + storage required, key `prequal/<buyer>/<random>`).
- Seller/agent: `GET /api/listings/{id}/prequalifications` (offers.view). Verified letters show summary, amount, conditions; pending/expired/none show status only. No buyer identity, file or bank details.
- Staff (`prequal.review`, compliance + super admin): `/staff/prequalifications`, `/staff/prequalifications/{id}/review`, bulk verify (only letters Elena read cleanly), PDF download (logged).
- Not built: OCR, auto expiry jobs, buyer email on decision, lender comparison, refinancing.
