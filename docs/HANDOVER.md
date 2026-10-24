# Handover

OwnerListing: Australian marketplace where owners list their own homes. AI assists, never accepts offers. The platform holds no money (deposits go to the solicitor's trust account). Decisions: PROJECT_STATUS.md. Rules: CLAUDE.md. Deploy: docs/DEPLOYMENT.md. Counsel questions: docs/COUNSEL_QUESTIONS.md.

## Feature map by role
| Role | What works (merged code) |
|---|---|
| Anyone | Home, browse and search (filters, sort, paging), public listing page with gallery, `/plans`, `/terms` |
| Owner | Google sign-in, create and edit draft, rental bond pathway, publish checks (disclosures, trust account, terms, fee paid), my listings, documents (upload UI, versions, deletion requests), job chat, assign photographer, solicitor or inspector, enquiries, issue single-use offer links, offer inbox and decisions, offer comparison, contract draft preview, checkout page, settings, dashboard |
| Agent | Appointed by the owner; publishes only with a full-scope appointment and a verified, unexpired licence |
| Buyer | Sign-up, saved searches and alert consent, enquire (needs verification), formal offer via single-use link |
| Contractor | Accept or decline assignment, job chat, upload own document kinds when approved |
| Staff | `/staff` dashboard, admin cases, trust-account approvals (two people), identity review (claim, view images, checklist), pricing, audit log; role read from the database per request |

## Placeholder or off
- Payments: adapter is a stub and the webhook format is our placeholder; nothing publishes until a real paid confirmation exists.
- Storage and malware scan: 503. Alerts: engine built, nothing sends. AI: rules-only, features report off.
- ID check: in-house photo ID + live selfie upload and staff review are built (encrypted images, claim-based audited viewing, retention job). Off until storage, ClamAV, `ID_IMAGE_KEY` and `ID_RETENTION_CRON_SECRET` are set. **Counsel must approve the retention periods, the privacy notice and Privacy Act handling before real use; this holds sensitive personal information, so a pen test is advised before real users.** Limits: no government-record (DVS) check, no deepfake or liveness detection, the in-app selfie can be bypassed by a determined user.
- Investment module hard-disabled (Gate G4). MFA not implemented in code. Report generators not built. Terms text is a draft.
- Known gaps: upload memory use and no per-user upload quota; browser check at 375, 768 and 1280 px not done; open PR #59 (enquiry offer-link request and owner issue flow) needs security review.

## Blocked on the owner
1. Google Workspace domain for staff linking.
2. Email provider and SMS provider.
3. Westpac PayWay merchant account (then real checkout and webhook from their docs).
4. Storage provider and malware scanner.
5. ID verification provider (DVS) and biometric handling decision; counsel sign-off on in-house ID image retention and Privacy Act handling.
6. ABN Lookup access key (free registration).
7. Counsel review: terms, contract template, retention and deletion, trust-account and licensing questions, AI-learning consent.
8. Compliance to supply state disclosure configuration; domain name; hosting; GPU server for AI.

## Working rules
One feature per PR; minimal patches; `npm test` and `npm run typecheck` are the gate; never skip tests or edit CI; security review for auth, uploads, ID data, raw SQL and payments; chat and published files are never deletable.
