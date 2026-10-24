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
| Staff | `/staff` dashboard, admin cases, trust-account approvals (two people), identity review checklist, pricing, audit log, staff access (invite, revoke, set role; admin only); role read from the active invite per request |
| Staff | `/staff` dashboard, admin cases, trust-account approvals (two people), identity review checklist, pricing, audit log, messaging settings (super admin); role read from the database per request |

## Placeholder or off
- Payments: adapter is a stub and the webhook format is our placeholder; nothing publishes until a real paid confirmation exists.
- Storage and malware scan: 503. Alerts: engine built; email and SMS adapters built but nothing sends until an admin enters settings. AI: rules-only, features report off.
- ID check: manual reviewer checklist only; image storage not built, so approval is blocked.
- Investment module hard-disabled (Gate G4). MFA not implemented in code. Report generators not built. Terms text is a draft.
- Known gaps: upload memory use and no per-user upload quota; browser check at 375, 768 and 1280 px not done; open PR #59 (enquiry offer-link request and owner issue flow) needs security review.

## Blocked on the owner
1. Email provider and SMS provider.
2. Westpac PayWay merchant account (then real checkout and webhook from their docs).
3. Storage provider and malware scanner.
4. ID verification provider (DVS) and biometric handling decision.
5. ABN Lookup access key (free registration).
6. Counsel review: terms, contract template, retention and deletion, trust-account and licensing questions, AI-learning consent.
7. Compliance to supply state disclosure configuration; domain name; hosting; GPU server for AI.
1. Google Workspace domain for staff linking.
2. Email account (SMTP details) and SMS account (Twilio-compatible). Not needed to build: the admin enters the phone and email details later in `/staff/messaging` (needs `MESSAGING_SETTINGS_KEY` on the server first; see docs/DEPLOYMENT.md 6a). Until then everything stays "not configured" and the outbox records that. Spam Act consent wording for alert and verification messages still needs counsel (docs/COUNSEL_QUESTIONS.md).
3. Westpac PayWay merchant account (then real checkout and webhook from their docs).
4. Storage provider and malware scanner.
5. ID verification provider (DVS) and biometric handling decision.
6. ABN Lookup access key (free registration).
7. Counsel review: terms, contract template, retention and deletion, trust-account and licensing questions, AI-learning consent.
8. Compliance to supply state disclosure configuration; domain name; hosting; GPU server for AI.

## Working rules
One feature per PR; minimal patches; `npm test` and `npm run typecheck` are the gate; never skip tests or edit CI; security review for auth, uploads, ID data, raw SQL and payments; chat and published files are never deletable.
