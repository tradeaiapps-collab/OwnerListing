# OwnerListing: Project Status

Brand name: **OwnerListing** (decided 23 Oct 2026). Domain not yet checked or bought. Remaining business decisions (hosting, ID provider, keys, counsel) are left to the end of the project.

Last updated: 2026-10-21. Source: Implementation Playbook v1.0 (20 Oct 2026) and Build 001 starter code.

## Architecture (decided)
- Login provider: Google (OIDC with MFA).
- Local dev port: 3004 (others are taken).
- TypeScript domain layer (pure functions, no framework), tested with Vitest.
- Planned: PostgreSQL for data, Next.js for the web front end, separate services later for AI and payments.
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
- Report catalogue: seller, buyer, solicitor, broker, suburb, sales, financial, audit, operations. External reports contain only the person's own data. Not yet built: the admin panel screens and the report generators.

## Documents (built 22 Oct 2026)
src/domain/documents.ts, db/010: upload validation (type, size, SHA-256), contractors may add only their own kinds and only when approved (photographer: photos and floorplans; inspector: reports; solicitor: contracts and title searches), visibility public / parties / owner_only, video, 360 photo and 360 video accepted. Deletion: owner can delete freely before the listing is first published; after the owner's final go-live approval files can only be amended (new version, old kept as superseded); contracts and title searches of a completed sale are always held. Chat history is never deleted (no deletion path exists). Counsel to confirm how a privacy deletion request is handled. Open: the upload service must check real file content and scan for malware; file storage provider choice; encryption at rest.

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

## Completed (Build 001)
- Listing publish rules, including disclosure gate and unverified-agent block.
- Offer policy: AI can draft but never accept; floor not exposed; escalation on out-of-mandate offers.
- Append-only audit model (in memory).
- Investment Gate G4 controls (disabled).
- Initial PostgreSQL schema (not yet applied), plus agent_licence table (db/002).
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
3. Add PostgreSQL migrations and audit persistence.
4. Auth with OIDC, MFA and role-based access (Phase 0).
5. Compliance (Shirin) to supply state disclosure configuration.
6. Australian legal review before any public launch (G0 and G1 controls).

## Site build status (23 Oct 2026)
One package per PR, CI is the gate (tests run only in CI). Merged: #2 import, #3 listings, #4 Postgres and Google login. Open and stacked, merge in this order: #5 enquiries, #6 offers, #7 mobile verification, #8 ID submission and staff review (security review needed), #9 enquiry spam limits and in-app alerts, #10 offer alerts.
- Blocked by design until a provider or sign-off exists: SMS (no provider, verification returns unavailable), ID image storage (no private store, submission unavailable), email alerts (no provider), payments, publishing (no state disclosure config).
- Open decisions: SMS provider; ID image storage and retention periods (counsel); counter-offers; whether several offers may be accepted.
- Known limits: selfie "taken in app" is a client declaration, reviewers still judge it; ID image purge function exists but nothing schedules it; no screen to assign staff roles yet (set in the database).
- Not done: responsive browser check (375, 768, 1280 px, light and dark; needs a browser), spec text for House Listing, Project Listing and Decisions, AI suggestions and negotiation mandate, vendor coordination, document management, admin dashboard, billing and terms modules, Queensland disclosure configuration.
