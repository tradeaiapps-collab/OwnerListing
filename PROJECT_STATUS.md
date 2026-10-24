# OwnerListing: Project Status

Brand name: **OwnerListing** (decided 23 Oct 2026). Domain not yet checked or bought. Remaining business decisions (hosting, ID provider, keys, counsel) are left to the end of the project.

Last updated: 2026-10-24, after PR #47 (acting-agent licence blocks publish) was merged. Earlier: PR #3 (listings), PR #4 (PostgreSQL migrations and Google login). Source: Implementation Playbook v1.0 (20 Oct 2026), Build 001 starter code and the merged code.

## Architecture (decided)
- Login provider: Google (OIDC with MFA).
- Local dev port: 3004 (others are taken).
- TypeScript domain layer (pure functions, no framework), tested with Vitest.
- PostgreSQL: migrations db/001 to db/016 plus a timestamped Google login and listing flags migration, run by scripts/migrate.mjs (PR #4).
- Next.js app (app/): Google login routes, listings API and listing pages (PR #4).
- Separate services later for AI and payments.
- Investment module hard-disabled until Gate G4.

## Team (playbook section 12)
Each role is assigned to an AI agent. Agents draft and build; accountable decisions and legal or licence sign-offs stay with a human.

| Role | Persian name | Owns | Assigned to |
|---|---|---|---|
| CTO | Golnar | Architecture, reliability, security | AI agent: Engineering (website-engineer skill). Human sign-off on architecture decisions: owner |
| AI/ML Lead | Arash | Negotiation engine, prompts, evaluation | AI agent: AI/ML (drafts prompts, evaluation plans). Human sign-off on model release: owner |
| Compliance Officer | Shirin | Licensing, disclosures, anti-discrimination | AI agent: Compliance drafting (checklists, disclosure config drafts). Accountable: owner plus Australian counsel |
| Head of Finance | Dariush | Ledger, commissions, payouts | AI agent: Finance drafting (ledger design). Accountable: owner plus accountant, after ledger ADR |
| Product Owner | Parisa | Roadmap, acceptance criteria, UX | AI agent: Product (project-manager skill, acceptance criteria, UX via ui-designer skill) |
| Vendor Success Lead | Negar | Vendor onboarding, disputes | AI agent: Vendor success (later phase). Human decision on disputes: owner |
| Customer Success Lead | Roya | Owner and agent support | AI agent: Customer success (later phase). Human escalation: owner |
| Investor Relations Lead | Kian | Investment section | AI agent: Investor relations (phase 4 only, blocked until G4). Legal sign-off: counsel |

## Workflow (confirmed by owner, 22 Oct 2026)
1. Owner creates the listing and publishes it (agent publishing is optional, later). Owner either takes photos or appoints a photographer; uses a platform solicitor or their own; uploads their own building and pest reports or uses the platform's.
2. Leads arrive in the portal and by email to the owner.
3. Owner starts negotiation. AI auto-replies to emails using the owner's chosen default or template, within the owner's mandate. AI never accepts, never gives legal advice, never reveals the floor. AI gives the owner an applicant report and summary (lawful factors only).
4. Owner decides. The AI drafts the contract from a template; both solicitors and the buyer receive copies.
5. Everything (listing, photos, reports, messages, contracts, audit) is saved in the database for future reference.

Needed next: photographer and solicitor assignment, document storage, message log and reply templates, applicant report, contract template, retention and privacy rules.

Rules to keep: contract drafts are template-based and reviewed by solicitors before signing; applicant data stored with consent (Privacy Act); every auto-reply is logged and the owner can pause it.

## Buyer workflow (confirmed by owner, 22 Oct 2026)
1. Buyer creates an account and portal, searches listings.
2. AI helps with the buyer's financial situation and gives a buying blueprint/strategy (first home buyer or investor), suggests suburb and property type, and introduces a broker from the platform.
3. Buyer details (including finances) are saved with consent.
4. Saved search with auto-notifications by email or text, per the buyer's preference, when a matching property is listed.

Rules to keep: AI gives general information and estimates, not personal financial or credit advice; broker introductions disclose any referral arrangement; suburb suggestions use budget, commute, growth and amenities, never demographics; email and SMS need consent and an unsubscribe (Spam Act 2003); financial data is minimised, encrypted and deletable (Privacy Act). Counsel to confirm credit and financial-advice licensing before launch.

## AI advisory (decided 22 Oct 2026)
Two AI modes. Public: general information, rough estimates and strategy, always with a disclaimer, no specific loan, lender or personal amount. Professional: only for a nominated broker with a verified credit licence and the buyer's consent; broker reviews and releases all output. Built: src/domain/ai-advisory.ts, db/005_broker.sql. Open: counsel to confirm the advice line; training on broker use only with client consent and de-identification (start with prompts and templates). Public AI output check built (src/domain/ai-public-guard.ts): blocks personal amounts, loan/lender recommendations and configured lender names; pattern check is a backstop only, needs AI evaluation tests too.

## Trust account verification (decided 22 Oct 2026)
Platform holds no money; deposits go to the nominated solicitor's trust account. Nothing publishes without an approved trust account for that job (fail closed). Automated per job: practising certificate, email confirmation from the registry-listed address, account name check, bank letter on file. Call-back only if the name check is unavailable. Registered firms with unchanged, previously human-approved details are auto-approved; new firms, unregistered firms and any changed details need one person to approve. Name mismatch or expired certificate is rejected. Built: src/domain/trust-account.ts, db/006, publish gate in decidePublish, and the verification runner (src/domain/trust-verification.ts) that runs the checks through swappable services and opens an admin case when a person must act. Counsel questions: docs/COUNSEL_QUESTIONS.md. Open: the services that gather the evidence (registry lookups differ by state and may not all be automatable), encryption of account numbers, counsel review.

## Job chat (decided 22 Oct 2026)
When a contractor (photographer, solicitor, inspector, agent) is assigned and approved, a chat opens for the owner and contractor. Messages are saved permanently: no edit or delete in code or in the database (db/007 trigger). Built: src/domain/job-chat.ts. Open: counsel to set retention and handle Privacy Act deletion or de-identification requests through a controlled legal process (not a user delete button); audited staff access for disputes; attachments storage.

## AI engine and learning (decided 22 Oct 2026)
Both engines are kept: prompts_templates (default) and trained_model; an admin chooses (src/domain/ai-learning.ts, db ai_engine_setting). Human decisions in negotiations, enquiries, contracts and broker work are collected only with explicit consent, with contact details redacted and no link back to the person (ai_learning_event). Everything stays on our own infrastructure. Open: consent wording in the terms, real de-identification review, counsel sign-off before any training.

## Data foundation (decided 22 Oct 2026)
Property-centred design for a future property-data site (db/008): property (canonical address, national address ID), property_event (insert-only history: listed, price changes, sold), property_document (title searches, reports, photos: file keys and hashes, source and reuse rights). Personal data stays separate from property facts. Third-party data (for example licensed title or valuation data) is stored with reusable_for_analytics = false unless rights are confirmed. Bank check failures create an admin_case for manual verification.

## Terms, admin panel and reports (decided 22 Oct 2026)
- Terms: users must accept the current terms (including the AI-learning clause) before posting; publishing is blocked otherwise (src/domain/terms.ts, db/009). Data is also de-identified before training. Counsel to confirm that bundled acceptance is enough.
- Admin panel rules (src/domain/staff-access.ts): staff roles super_admin, compliance, accountant, support, technical, reporting with least-privilege permissions. Overrides need a reason and are logged (override_log); non-super-admin requests and safety gates (trust account, licence) need a second person; audit log and chat are never rewritten, only annotated.
- Report catalogue: seller, buyer, solicitor, broker, suburb, sales, financial, audit, operations. External reports contain only the person's own data. Built (24 Oct 2026, PR feat/staff-admin): staff dashboard /staff, admin cases /staff/cases (claim, resolve with reason; trust and licence cases are overrides needing a second authorised person, logged in override_log), trust account approvals /staff/trust-accounts (new or changed details need two different approvers; db/20261024140000), identity review /staff/id-review (checklist only; approval blocked until image storage exists; reviewers cannot review their own check). Assumption: trust admin_case.subject_id is the trust_account_check id. Not yet built: the report generators, identity image storage.

## Documents (built 22 Oct 2026)
src/domain/documents.ts, db/010: upload validation (type, size, SHA-256), contractors may add only their own kinds and only when approved (photographer: photos and floorplans; inspector: reports; solicitor: contracts and title searches), visibility public / parties / owner_only, video, 360 photo and 360 video accepted. Deletion: owner can delete freely before the listing is first published; after the owner's final go-live approval files can only be amended (new version, old kept as superseded); contracts and title searches of a completed sale are always held. Chat history is never deleted (no deletion path exists). Counsel to confirm how a privacy deletion request is handled. Upload (24 Oct 2026, PR feat/file-upload): POST /api/listings/[id]/documents (src/domain/document-upload.ts) needs a session and owner or approved contractor role, checks real type from magic bytes (src/domain/file-sniff.ts), ignores filenames, stores only a random key and SHA-256, versions via supersedes (no delete). Storage and malware scanner are ports (src/adapters/object-storage.ts, malware-scan.ts) that fail closed until a provider is configured; uploads return 503 meanwhile. Screen and download (24 Oct 2026, PR feat/documents-ui-download): app/listings/[id]/documents (upload form, versions, deletion requests only), GET /api/documents/[id]/file (readDocumentFile in document-service.ts enforces visibility, superseded files owner-only, denial answers 404, storage off 503, non-public downloads audited as document.downloaded; ObjectStoragePort.get added), public listing gallery (public active photos, floor plan and video links). Open: choose storage provider and scanner, streaming upload for videos over 100 MB, encryption at rest, security review.

## Plans and AI descriptions (built 22 Oct 2026)
- Plans (src/domain/plans.ts, db/011): Basic, Standard, Premium entitlements (photo limit, storage, video, 360, AI description, AI auto-reply, applicant report, contract drafting) plus add-ons. Prices are set by an admin (new permission pricing.manage, super admin only), excl. GST, as new rows with a reason; a subscription locks its price; unpriced plans cannot be bought. Open: choose a payment provider for platform fees (card data must never touch our servers), GST invoicing, and whether to charge online or by invoice. This is the platform's own fee, separate from deposits, which never touch the platform.
- AI reading reports and photos (src/domain/ai-description.ts): the AI drafts a property description from the owner's PDFs and photos with each claim citing a file. Checks: every claim cites a current file; absolute claims ("defect-free", "termite-free", "structurally sound") are blocked; availability of the building and pest reports must be stated; adverse findings must be disclosed. Owner approves before use. Open: the reading service itself (PDF and image input to the AI), accuracy testing, and use of licensed suburb reports only within their licence terms.

## Platform rules (decided 22 Oct 2026)
- Time zones: every timestamp stored in UTC; shown in the viewer's zone; legal and business deadlines measured in the property's state zone and shown in both (src/domain/timezone.ts, db/012 user_preference).
- Languages: user chooses a language and its catalogue loads; a language is enabled only after a human reviews its catalogue; falls back to English, never blank; right-to-left support (fa, ar); legal documents, disclosures and terms stay in English and translations carry an "English prevails" notice; chat originals are never changed, translations are separate rows (src/domain/i18n.ts).
- Online billing: owners pay platform fees online. Provider not decided, probably Westpac PayWay (hosted payment page, API, recurring billing exist). Built provider-neutral (src/domain/billing.ts): GST 10%, invoices, idempotent payment events, amount checks, signature-checked webhooks; card numbers never reach our servers. Mismatched amounts create an admin case. Open: choose provider, merchant application, PCI scope confirmation (hosted page keeps it small).
- Scale and team: see docs/SCALING_AND_TEAM.md (scaling plan, human team roles and maintenance routine). Keyset pagination helper built (src/domain/pagination.ts).

## Scope: sales and rentals, residential and commercial (decided 23 Oct 2026)
- Listings carry use class (residential or commercial) and commercial property types; a mismatched type is blocked. Required disclosures are configured per state, sale or rent, and use class (src/config/disclosures.ts).
- Deposits: sales need an approved solicitor trust account. Rentals must confirm how the bond is held (state bond authority, solicitor trust, bank guarantee, or none); the trust account gate applies only if it goes to a solicitor. The platform never holds money. Rules differ by state; counsel to confirm.
- Buyer side (src/domain/buyer.ts, db/013): saved searches on property facts only, alerts only with recorded consent and unsubscribe, one alert per buyer per channel, email and phone verification to enquire, ID verification to make an offer or apply (confirmed by owner 23 Oct). Open: tenant application flow and tenant screening rules (anti-discrimination), commercial lease flow, ID verification provider, SMS provider, alert delivery and matching service.

## Offers (decided 23 Oct 2026)
Offers on the platform only count when made through the formal form. If a buyer mentions an offer in chat, an automated message (not more than once an hour) explains that chat offers are not formal and gives a secure link to the offer form, asking whether it is their formal, final offer. The link is single-use, expires after 24 hours, is tied to one buyer and one property, and only its hash is stored. The form must be ticked as final, and shows a notice that an offer is not a contract. An ID check is needed before the form opens. Submitted offers go to the owner; the AI analyses; the owner decides; the AI never accepts. Built: src/domain/offer-intake.ts, db/014. Open: the screens, delivery of the automated chat message, the buyer-owner negotiation chat storage (system messages), offer status screens, counsel review of the form wording.

## Buyer verification (decided 23 Oct 2026)
Anyone can sign up (verified email) and explore: browse, saved searches, alerts. The first time someone tries to contact a seller (enquire, chat, offer, apply for a rental) the full check starts: verified mobile plus ID document check against government records plus live selfie match. Done once, reused on every listing (src/domain/buyer.ts canContactSeller, nextVerificationStep). Planned extras: optional proof-of-funds badge, behaviour checks (enquiry limits, duplicate-device flags, missed inspections), owner reports reviewed by an admin, limited buyer details shown to the owner until accepted, ABN check for company buyers, MFA sign-in. Open: choose the ID verification provider (government document check plus liveness), cost per check, biometric privacy handling, counsel on AML/CTF duties.

## Interim identity check (decided 23 Oct 2026)
Until an outside provider is chosen, identity checks are done by our own reviewers (src/domain/id-verification.ts, db/015). The buyer submits the front and back of a licence (or the passport photo page), the expiry date and a live selfie taken in the app. A reviewer with the new identity.review permission (compliance, super admin) ticks four checks: looks genuine, photo matches selfie, name matches the account, in date; all must pass. Australian documents need one reviewer, overseas documents two different reviewers. Staff cannot review their own check. Document numbers are never stored; images sit in private encrypted storage, every view is logged, and images are deleted 7 days after approval or 30 after rejection (counsel to confirm). Three attempts a day. Verified buyers are marked method = manual_review so they can be re-checked later by a provider. Limits: manual review cannot check government records or reliably catch deepfakes and does not scale to large volumes, so it is a stopgap. The provider interface (IdProviderPort) is ready to replace it. Finding (23 Oct): Queensland's Transport and Main Roads has only a public single-lookup page, Check driver licence status (licence number, name and date of birth; returns whether the licence is current; no class or conditions). No API or bulk access was found, and the page is for a licence holder or someone shown the licence, so automated scraping is not appropriate. The route that covers every state is the Document Verification Service through an approved provider. Option: add a reviewer checklist item to use each state's official status page by hand where one exists. Open: the screens, encrypted image storage, reviewer queue screen (admin_case kind identity_verification), counsel on holding ID images and biometrics.

## Licence status, ABN and passports (decided 23 Oct 2026)
- Australian driver licences: the reviewer checks the licence is current on the state's official public status page where one exists (Queensland has one) and records done, not_available or failed; failed blocks approval (src/domain/id-verification.ts). Passports have no public check, so they rely on manual review, with two reviewers for overseas passports, until a DVS provider is connected.
- Business and trust buyers (src/domain/abn.ts, db/016): the ABN must pass the official checksum, be active on the Australian Business Register, and its name must match; the person acting must have passed the ID check and a reviewer must have seen proof of authority. If the register cannot be reached an admin takes over. The register's ABN Lookup web service is free; register once to receive an access key (GUID) and accept its agreement. Built: the real lookup (src/adapters/abr-lookup.ts, key read from the environment, never committed) and the 30-day re-check rule. Open: register for the key; a scheduled job to run the re-checks once the database is connected.

## AI is self-hosted (decided 23 Oct 2026)
No outside AI account. src/domain/ai-engine.ts is the plug-in: an open-source model on our own GPU server, with OCR for scanned PDFs. Until installed, AI features report they are off. Running cost: a GPU server (open).

## Owner pays before listing (decided 23 Oct 2026)
decidePublish now blocks any listing until the owner's listing fee or plan is paid (listingFeePaid). This is our own fee, charged online; it is not a deposit, and the platform still never holds buyer or tenant money. The fee is a flat price per listing, by package (Basic, Standard, Premium); the admin sets each price. isListingFeePaid (billing.ts) checks for a paid invoice for that owner and listing and feeds decidePublish. Open: connect it to the real Westpac payment confirmation.

## Payments: Westpac PayWay (decided 23 Oct 2026)
Westpac is the bank and payment provider. src/adapters/westpac-payway.ts holds the settings and fails closed until connected. Open: apply for a PayWay merchant account; then build the real checkout and webhook signature check from Westpac's documentation, and set listingFeePaid from a confirmed payment.
Built 24 Oct 2026 (feat/plans-checkout): public /plans, staff /staff/pricing (pricing.manage, new price rows with a reason), owner /listings/[id]/checkout (GST invoice, idempotent, locked price, unpriced plan unbuyable) and /api/webhooks/payway (HMAC-SHA256 in x-payway-signature, secret PAYWAY_WEBHOOK_SECRET, constant-time, idempotent by event id, amount mismatch opens an admin case, rejects all while the secret is unset). The adapter still fails closed, so checkout answers "not available yet" and nothing publishes. The webhook body and header are our placeholder format until Westpac's documentation replaces them. Open: transactions across the settle steps, refunds for payments on replaced invoices.

## Completed (Build 001)
- Listing publish rules, including disclosure gate and unverified-agent block.
- Offer policy: AI can draft but never accept; floor not exposed; escalation on out-of-mandate offers.
- Append-only audit model (in memory).
- Investment Gate G4 controls (disabled).
- Initial PostgreSQL schema plus agent_licence table (db/002); migration runner and Google login merged in PR #4.
- CI workflow (.github/workflows/ci.yml) runs typecheck and tests.
- Unit tests for the above. Not run yet: npm registry was unreachable from the build environment.

- Website scaffold (Next.js, files only, not installed or run): home page, dry-run publish check page, /api/listings/check. Fails closed: no state has disclosure config yet, so every check is blocked until Compliance supplies it (src/config/disclosures.ts).

- Role and record-level access rules (src/domain/access.ts). Only admins verify licences.

- Owner-appoints-agent model: appointment table (db/004), appointed agents handle enquiries and analyse offers, only the owner approves offers, publishing by an agent needs scope "full" and a verified licence. Default is owner publishes.

- Auto-reply with owner review window (src/domain/auto-reply.ts): routine replies from owner-approved templates wait for a review window (default set by owner) before sending; owner can pause, edit, cancel or take over; counters and out-of-mandate items always go to the owner. Still to build: owner discussion thread with the AI for each negotiation (UI).

## Open issues (from review)
1. FIXED: Agent check now reads ownerUserType (mirrors app_user.user_type). Agent licence table added (db/002_agent_licence.sql). Licence lookup helper added (src/domain/licence.ts). Publish path now uses decidePublish (src/domain/publish.ts). Still open: no API route calls it yet.
2. FIXED: Per-round concession limit enforced (proposedConcessionBps). Still open: targetPriceCents is unused.
3. FIXED: Offer decision field renamed to mayDraft.
4. Floor-leak test only checks one number. Check full output and reason text.
5. Investment test name contradicts its behaviour. Rename.
6. PARTLY FIXED: repository port and SQL written (src/domain/audit-repository.ts), append-only trigger in db/003. Still open: PostgreSQL driver and adapter (needs npm).
7. FIXED: package-lock.json created on first install (owner's machine, 22 Oct).
8. FIXED: listing status changes go through transitionListing (src/domain/listing-transitions.ts); publishing needs an allowed decision and emits an audit event.
9. FIXED: agent_licence table added (db/002). Verification stays a human action.

## Next steps
1. DONE 22 Oct on owner's machine: npm install, npm test (43 passed, 13 files), typecheck clean. npm audit (22 Oct): fixed. Upgraded to next 16.4.2, vitest 5.0.5, vite 8.3.5 on owner's machine; 43 tests pass, typecheck clean, 0 vulnerabilities. Do not use audit fix --force.
2. Items 3 to 7, licence table, and targetPriceCents.
3. DONE (PR #4): PostgreSQL migrations and Google login. Audit writes go to PostgreSQL (appendAuditPg in src/server/db.ts, wired in src/server/context.ts). Role checks are now enforced on the listing create and publish routes (#16, tested in #18). Audit reads now have a caller (#38 staff audit log). Still open: MFA is not implemented in code.
5. Compliance (Shirin) to supply state disclosure configuration.
6. Australian legal review before any public launch (G0 and G1 controls).
7. MERGED since #15: #16 role checks on the listing create and publish routes; #18 route-level role-check tests (401/403/400/201/404/200); #19 owner UI to set the rental bond pathway, on the new-listing page only.
8. MERGED with the owner's explicit approval (24 Oct 2026, security-sensitive, self-review only, no independent security review yet): #17 agent publishing with a full-scope appointment (widens who can publish; adds a parameterised raw SQL lookup); #20 verified licence records wired into publish (read-only query on agent_licence). #20 needed a small conflict fix with #17 (kept both sides). Agent publishing now works end to end once a verified, unexpired licence exists; an independent security review is still recommended before go-live.
9. MERGED: #22 edit-draft page; #24 saved bond pathway shown to the owner on it (owner-only field); #25 screenshot workflow (separate from `gate`); #26 public listing page; #32 public listing responses no longer include ownerUserId or ownerUserType (server-computed isOwner instead).
10. NOT DONE: browser check of the pages (bond pathway UI first) at 375, 768 and 1280 px, light and dark (code inspection only so far).
11. Launch items waiting on others: Compliance (disclosures), counsel (docs/COUNSEL_QUESTIONS.md), ABN Lookup key, Westpac PayWay, an ID provider. No live payment keys.
12. MERGED 24 Oct 2026 (owner merged; security-sensitive, self-review only): #27 My listings page and API; #28 job chat API and page (append-only, no attachments); #29 documents list and deletion requests (no upload, no storage); #30 owner offers inbox (buyer submits by single-use link; owner read-only so far); #31 buyer saved search and alert consent (no alerts sent).
13. MERGED since #34: #33 buyer sign-in (buyer session claim, role choice at login, migration); #35 offers flow (owner issues single-use links, accepts/rejects/counter-requests, submit route rate limited); #36 contractor assignment (invite, accept/decline, status, list; unlocks job chat); #37 staff sign-in via Google (role read from the database per request); #38 staff audit log (read-only search API and page for report.audit); #39 design pass (shared styles, tokens, dark mode, responsive header and home page). Nothing in progress.
14. MERGED since #39: #41 design pass 2 (no inline styles left in app/); #42 saved-search alert engine (src/domain/alerts.ts, fail-closed delivery port, insert-only alert_delivery log; no provider chosen, nothing sends); #43 file upload (fail-closed storage and malware ports, 503 until providers are chosen, magic-byte check, no delete path); #44 offer link bound to the buyer session, client IP taken from trusted hops (env TRUSTED_PROXY_HOPS), generic offer-link errors, issuance limit; #45 CSRF origin and content-type guard on state-changing routes (APP_URL must be set exactly in every environment or those routes return 403); #46 user session checked against app_user on every request, other session cookie cleared at sign-in; #47 acting-agent licence blocks publish.
15. MERGE RULE (owner's standing rule, 24 Oct 2026): all merges are done by Claude once CI is green on the head commit after merging main.
16. SECURITY REVIEW: independent review done 24 Oct 2026, no critical or high findings. Open: staff first-login linking by email match needs the Google Workspace domain (hd claim) from the owner.
17. KNOWN GAPS: upload memory use; large video upload needs streaming or presigned upload; file download not built; browser check of pages at 375, 768 and 1280 px not done (see item 10).
18. REMAINING QUEUE: (a) choose storage and malware scanner providers (upload returns 503 until then); (b) choose an email/SMS provider so alerts can send; (c) payments (blocked on Westpac PayWay, no live keys); (d) owner to supply the Workspace domain for staff linking; (e) file download; (f) browser check (see item 10).

## Account settings and terms (PR: feat/account-settings-terms, 24 Oct 2026)
Versioned terms with insert-only acceptance log (db/20261024160000), /terms accept page, publish needs current terms for owner and actor (domain dep termsCurrentFor). /settings stores language and time zone per user (default en-AU, Australia/Sydney). /dashboard lists owner, agent, buyer and staff tasks. Open: counsel to approve the terms text (seed version 2026-10-24 is a draft); offers, enquiries and listing create are not yet gated on terms; staff have no settings page (separate sign-in).
## Offer comparison and contract draft (built 24 Oct 2026, PR feat/offer-analysis-screens)
Owner-only (404 for others): /listings/[id]/offer-analysis (sorted table of price, deposit, settlement days, conditions; no buyer identity; src/domain/offer-analysis.ts) and /listings/[id]/contract-draft (template preview labelled "Draft, not legal advice. Solicitor to review before anyone signs."; src/domain/contract-draft.ts; nothing stored or sent). APIs: GET/POST /api/listings/[id]/offer-analysis, POST /api/listings/[id]/contract-draft (csrfGuard on POST, audited). Optional AI summary goes through the AI port (src/server/ai.ts, rules-only engine today): off, errors or output that steers a decision all give an "AI unavailable" state. AI never accepts, rejects or counters. Open: plan entitlement checks (ai_applicant_report, contract_drafting) not enforced yet; AI summary has no rate limit; solicitor-approved template and counsel review (COUNSEL_QUESTIONS 7, 16) pending.
