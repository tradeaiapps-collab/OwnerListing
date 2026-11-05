# E-signing: brief for counsel (built-in signing today, DocuSign as an option)

Status 5 Nov 2026. **DocuSign is not integrated.** No account, keys or code exist. What is built is our own click-to-sign (PR #168, `docs/DOCUMENT_SIGNING.md`). This brief states, per topic, what the code does now, what a DocuSign swap would change, and what we cannot claim. Questions for counsel are 29-32 in `docs/COUNSEL_QUESTIONS.md`. The platform is Australian, so the relevant law is the Electronic Transactions Act 1999 (Cth) and the state equivalents, not US UETA or ESIGN. Those are mentioned only if counsel wants US parity.

## 1. Workflow (built-in)
Owner generates a document from a staff-published template, names signers (each needs an account) and sends it. Text and its SHA-256 are frozen at creation (DB triggers). Each signer opens it (recorded), types their name exactly as on their account, ticks consent, and signs. All signed means `completed`. Files: `src/domain/signing-service.ts`, `db/20261105100000_document_templates_esign.sql`.
Storage: rendered text, hash, signer rows and events live in Postgres. There is no PDF or sealed certificate yet (open item).
With DocuSign: the owner's send step would create an envelope; signers sign on DocuSign; a webhook would mark our signer rows and store the completed PDF plus certificate of completion. Our hash would no longer be the evidence of record. DocuSign's PDF and certificate would be.

## 2. Audit trail
Built: `signing_event` is insert-only (trigger refuses UPDATE/DELETE). Events: created, sent, viewed, explained, signed, declined, completed, cancelled. Each row has document SHA-256, time, IP, user agent (300 chars max), actor and signer. Gap: IP is the last `x-forwarded-for` entry, so it is only as trustworthy as our proxy setup. Confirm production sits behind a single trusted proxy before relying on it. DocuSign would add its own certificate with IP and timestamps.

## 3. Compliance claims
We make **no** claim on DocuSign's SOC 2, ISO 27001 or eSignature-law compliance. Those must be taken from DocuSign's current trust documents and its Australian contract terms, not from us. HIPAA is a US health-data regime and is not relevant to real estate. Checklist to obtain before counsel review: SOC 2 Type II report (under NDA), data residency (Australian region available?), sub-processors, DPA, eSignature legality statement for Australia. For the built-in method, whether typed name plus consent satisfies the ETA "reliable method and consent" tests is Q29.

## 4. Retention and deletion
Built: no retention rule for signing records. They are kept indefinitely and cannot be deleted by design (insert-only, immutable text). That conflicts with the account-deletion flow unless counsel confirms a contractual-records exception (Q31). With DocuSign: its envelope retention would need to be set or exported, and deletion requests handled in both systems.

## 5. Signer verification
Built: the signer must be logged in with an active account matched by email (email confirmed at signup). Phone codes exist (`phone-verification.ts`: 10 min expiry, 5 guesses) but are **not** required at signing. Typed name must match account name. No ID check at signing. Options: require verified phone or the in-house ID check for listed document types; DocuSign offers SMS and ID-check add-ons at extra cost.

## 6. Witness and notary
Not supported. No witness field, no deed execution, no remote notarisation. Templates are limited to non-contract documents and exclude contracts of sale. If counsel says some documents need witnesses (existing Q8), the design is a per-template `requires_witness` flag with a second signer role and its own events. Remote witnessing rules vary by state (Q30).

## 7. Rejection and non-signing
Built: a decline by any signer closes the whole document (`declined`), with optional reason recorded. Owner can cancel at any time before completion. Gap: documents never expire and there are no reminders or emails to signers (no outbound email wired for signing). Proposed: 14-day expiry, reminder notification, auto-cancel event.

## 8. Integration security
Built: signing routes require sign-in and CSRF protection; permissions limit template edit/publish to two different staff; Elena only reads staff-approved text. The security review of signing is still open. For DocuSign: OAuth (JWT grant) keys held in provider-keys infrastructure (`docs/PROVIDER_KEYS.md`, encrypted at rest); inbound webhook verified by HMAC with constant-time compare, as done for PayWay (`app/api/webhooks/payway/route.ts`, `src/server/payment-webhook.ts`), with 64 KB body cap and replay window; signed PDF stored encrypted with the document store's malware scan. None of this exists for DocuSign yet.

## Gaps summary
1. No DocuSign code or account. 2. No PDF or certificate. 3. No retention/deletion rule. 4. No witness support. 5. No expiry or reminders. 6. Phone verification not required at signing. 7. Security review pending. 8. Compliance claims for DocuSign unverified.
