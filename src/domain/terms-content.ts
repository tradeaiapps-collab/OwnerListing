/**
 * Full text of the OwnerListing Terms and Privacy. Plain data, rendered by app/terms/page.tsx.
 * Bump TERMS_TEXT_VERSION whenever the text changes, and add a matching terms_version row.
 * DRAFT: Australian counsel must review before publication (docs/COUNSEL_QUESTIONS.md).
 */
export const TERMS_TEXT_VERSION = "2026-11-draft-2";
export const TERMS_LAST_UPDATED = "6 November 2026";
export const TERMS_OPERATOR = "[Operator legal name] ABN [to be inserted]";
export const TERMS_CONTACT = "[support and privacy contact email to be inserted]";
export const TERMS_GOVERNING_STATE = "Queensland";

export interface TermsSection { id: string; title: string; paragraphs: readonly string[] }
export interface TermsPart { id: string; title: string; sections: readonly TermsSection[] }

export const TERMS_PARTS: readonly TermsPart[] = [
  {
    id: "service",
    title: "1. The service",
    sections: [
      {
        id: "about",
        title: "1.1 About these terms",
        paragraphs: [
          `These terms are an agreement between you and ${TERMS_OPERATOR} ("OwnerListing", "we", "us"). They cover the website, the mobile app and every related service (the "Platform"). By creating an account, posting, or using the Platform after signing in, you agree to them together with the privacy section (Part 4) and cookie policy (4.7).`,
          "If you do not agree, do not use the Platform. Browsing public listings does not need an account.",
        ],
      },
      {
        id: "what",
        title: "1.2 What the Platform does",
        paragraphs: [
          "OwnerListing is an online marketplace where owners list their own property for sale or rent, buyers and renters find and contact them, and approved contractors (for example photographers, inspectors and solicitors) and licensed agents can be engaged. We provide tools for listings, enquiries, chat, offers, documents, contracts and reports.",
          "We also provide an AI assistant. It can draft replies, summarise enquiries, compare offers and prepare reports. You decide what to send and what to accept.",
        ],
      },
      {
        id: "not",
        title: "1.3 What the Platform does not do",
        paragraphs: [
          "We are not a real estate agent, a conveyancer, a solicitor, a financial adviser, a mortgage broker, a valuer, or a party to any sale, lease or investment. We do not give legal, financial, tax or property advice. Price suggestions, reports and AI output are general information only.",
          "We do not hold or handle your money. Deposits and settlement funds go to the solicitor's trust account, never to us. We do not guarantee that any listing is accurate, that any buyer or renter is genuine, or that any sale, lease or investment will complete.",
          "Investment projects are listed so that eligible people can express non-binding interest. We do not make offers of securities or managed investments and we do not take investor money.",
        ],
      },
      {
        id: "ai",
        title: "1.4 AI assistant",
        paragraphs: [
          "AI output can be wrong or incomplete. Check it before you rely on it or send it. The AI never accepts, rejects or signs an offer, contract or any other binding document for you. Only you, or a person you have authorised in writing, can do that.",
          "Our AI runs on our own infrastructure. If you accept a terms version that includes the AI learning clause, you consent to us using your decisions in negotiations, enquiries, contracts and broker work to improve the AI. Contact details are removed first, the data is not linked back to you, and it is not shared with outside AI providers. Without that consent your data is not used for training.",
        ],
      },
      {
        id: "responsibilities",
        title: "1.5 Your responsibilities",
        paragraphs: [
          "You must give true, current and complete information, keep your login secure, and tell us promptly if you think someone else has used your account. You are responsible for everything done under your account.",
          "You must follow the law, including consumer law, anti-discrimination law, privacy law, spam law and the real estate and disclosure rules of the state where the property is. You must have the right to list a property and to upload everything you post.",
          "You must not: post false or misleading information; discriminate in a listing or when choosing between applicants; harass or threaten anyone; upload malware or unlawful content; scrape, copy or resell Platform data; try to get around identity, licence or payment checks; contact people for purposes unrelated to a listing; or move a deal off the Platform to avoid a fee you owe.",
          "We may use automated and manual checks, including a wording filter that flags discriminatory listing text for review.",
        ],
      },
      {
        id: "availability",
        title: "1.6 Availability and changes",
        paragraphs: [
          "We aim to keep the Platform running but do not promise it will be uninterrupted or error free. We may change, pause or remove features. If a change materially harms paying customers we will give reasonable notice where we can.",
          "Some features depend on outside providers (for example payments, SMS, email, identity checks, mapping and storage). If a provider is not available, the related feature may be switched off until it is.",
        ],
      },
    ],
  },
  {
    id: "payments",
    title: "2. Payments and fees",
    sections: [
      {
        id: "no-commission",
        title: "2.1 No commission on house sales and rentals",
        paragraphs: [
          "We do not charge a sale commission or a rental placement fee on house and rental listings. Owners pay a flat fee for the listing package they choose (for example Basic, Standard or Premium). Subscription plans for owners and agents are charged at the monthly price shown on the Plans page when you buy. Prices are set by us and may change for future purchases.",
          "Investment project listings are different. The poster pays either an upfront fee or a commission, as shown for that project and agreed before it is published. A commission is invoiced to the poster, never taken from investor money.",
          "Other people you hire through the Platform (agents, photographers, solicitors and so on) set their own fees. Those are between you and them.",
        ],
      },
      {
        id: "trust",
        title: "2.2 Trust account and deposits",
        paragraphs: [
          "Deposits, holding deposits, bonds and settlement money are paid to and held by the solicitor or other legally authorised trustee under the law of the relevant state. We do not receive, hold, release or guarantee those funds. A listing cannot be published unless a verified trust account is on record.",
          "Any dispute about a deposit is between the parties and their trustee.",
        ],
      },
      {
        id: "payment-terms",
        title: "2.3 How you pay us",
        paragraphs: [
          "Our fees are charged online through our payment provider or by bank transfer, in Australian dollars, with GST (10%) shown on a tax invoice. Card details go to the payment provider and never reach our servers.",
          "Invoices are due within 14 days unless stated otherwise. A listing is not published until its fee is paid. Subscription plans bill per period; a renewal invoice is issued before the period ends, and a plan that is not paid lapses after a short grace period. You can cancel a plan at the end of the current period.",
        ],
      },
      {
        id: "refunds",
        title: "2.4 Refunds",
        paragraphs: [
          "Nothing in these terms limits your rights under the Australian Consumer Law, including the consumer guarantees that cannot be excluded. If a service is not provided with due care and skill or a fee was charged in error, you are entitled to a remedy, which may include a refund.",
          "Otherwise, a listing fee is refundable in full if the listing has not been published, and is not refundable after publication unless the law requires it or we agree. Fees paid on a replaced or duplicate invoice are refunded. Refunds go back to the original payment method. Send payment questions or disputes in writing to the contact in 6.1 and we will answer in writing.",
        ],
      },
    ],
  },
  {
    id: "content",
    title: "3. Content and records",
    sections: [
      {
        id: "ownership",
        title: "3.1 Who owns what",
        paragraphs: [
          "You keep ownership of the content you post, including listings, descriptions, photos, floor plans, videos, documents and messages (together, your content). We own the Platform, its design, software, brands and our own data, but not your content.",
          "Photos and files a contractor uploads for your listing belong to the contractor or you as agreed between you; by uploading them to your listing, the uploader confirms they may do so.",
        ],
      },
      {
        id: "licence",
        title: "3.2 Licence you give us",
        paragraphs: [
          "You give us a non-exclusive, worldwide, royalty-free licence to host, copy, resize, display, translate and distribute your content as needed to run the Platform, show your listing to the public and to users you choose, and to comply with the law. For a published listing this includes showing photos, floor plans and videos you marked public. The licence for content that is a permanent record (3.4) continues after you leave.",
          "You promise that your content is yours or you have permission to use it, that it does not infringe anyone's rights, and that it is not defamatory, misleading or unlawful. Listings must not include other people's personal information without a lawful reason.",
        ],
      },
      {
        id: "visibility",
        title: "3.3 Visibility of files",
        paragraphs: [
          "Each file has a visibility level: public, parties to the transaction, or owner only. We show it only to the people allowed to see it. Contracts and title searches are not public. Accessing a non-public file is logged.",
        ],
      },
      {
        id: "permanent",
        title: "3.4 Permanent records",
        paragraphs: [
          "To protect everyone in a transaction and to resolve disputes, some records are kept permanently and cannot be deleted or edited by you or by us through the Platform. These are: chat messages; offers, counter-offers and their history; signed contracts and title searches of a completed sale; sale and rental outcome events; and files from a listing after the owner's final approval to go live.",
          "After go-live a file can be replaced by a new version, but the earlier version is kept as superseded. Before a listing is first published, the owner may delete its files. Staff cannot delete these records either. Access by staff is limited and logged.",
          "Privacy requests that touch permanent records are handled under 4.5: we may de-identify them or restrict access rather than erase them, because the law and the other parties' interests require the record to exist.",
        ],
      },
      {
        id: "removal",
        title: "3.5 Removal of content",
        paragraphs: [
          "We may hide or take down content, or refuse to publish a listing, if we reasonably believe it breaks these terms or the law, or a state disclosure or licence requirement is not met. We will tell you why when we can. If you think content infringes your rights, send a notice to the contact in 6.1 with enough detail to find it.",
        ],
      },
    ],
  },
  {
    id: "privacy",
    title: "4. Privacy, data and cookies",
    sections: [
      {
        id: "privacy-collect",
        title: "4.1 What we collect",
        paragraphs: [
          "We collect only what we need: account details (name, email, mobile), listing and enquiry content, messages, offers, documents, payment records (not card numbers), device and usage data, and, where verification is required, identity information.",
          "For identity checks we may collect a copy of an Australian ID document and a live selfie. These are stored encrypted, viewed only by authorised reviewers with every view logged, and deleted 7 days after approval or 30 days after rejection. We do not store the document number. We ask for your separate consent first. Business users may also be checked against the Australian Business Register, and agents against the relevant licence register.",
        ],
      },
      {
        id: "privacy-use",
        title: "4.2 How we use and share it",
        paragraphs: [
          "We use personal information to run your account, show and manage listings, connect the parties to a transaction, verify identity and licences, prevent fraud and discrimination, take payment, provide support, meet legal duties, and improve the Platform.",
          "We share it with: the other party to a transaction (only what the rules for that stage allow; buyers' details are limited until an offer is accepted); contractors and agents you appoint; trust accounts and solicitors; service providers that host, email, text, pay, verify or map for us, under contract; regulators and law enforcement where required; and a buyer of our business with the same protections. We do not sell personal information.",
          "Some providers may be outside Australia. We take reasonable steps to make sure they protect your information as the Australian Privacy Principles require.",
          "We only send marketing, alerts and SMS where you have agreed (Spam Act 2003). You can unsubscribe at any time.",
        ],
      },
      {
        id: "privacy-security",
        title: "4.3 Security and breaches",
        paragraphs: [
          "We use access controls, encryption for sensitive files, logging and rate limits. No system is perfectly secure. If a breach is likely to cause serious harm, we will notify you and the Office of the Australian Information Commissioner as the Notifiable Data Breaches scheme requires.",
        ],
      },
      {
        id: "privacy-rights",
        title: "4.4 Access and correction",
        paragraphs: [
          "You can ask to see the personal information we hold about you and to correct it. Most details can be changed in your account settings. Write to the contact in 6.1; we aim to respond within 30 days.",
        ],
      },
      {
        id: "privacy-deletion",
        title: "4.5 Retention, deletion and de-identification",
        paragraphs: [
          "You can close your account at any time. When you do, we delete or de-identify personal information we no longer need, except where we must or may keep it: permanent records (3.4), tax and payment records (usually seven years), records needed for a dispute or investigation, and safety and fraud logs.",
          "We do not offer a delete button for permanent records. Requests to delete or de-identify them are reviewed by us individually, with legal advice where needed.",
        ],
      },
      {
        id: "privacy-complaints",
        title: "4.6 Privacy complaints",
        paragraphs: [
          "Send a privacy complaint to the contact in 6.1. If you are not satisfied with our response you can complain to the Office of the Australian Information Commissioner (oaic.gov.au).",
        ],
      },
      {
        id: "cookies",
        title: "4.7 Cookie policy",
        paragraphs: [
          "We use cookies and similar technology. Essential cookies keep you signed in, protect forms from forgery, and remember choices such as theme and language. They are needed for the Platform to work and cannot be turned off.",
          "Optional cookies (for example analytics, and advertising measurement if we use it) are used only with your consent where the law requires, and you can change your choice at any time. You can also block or clear cookies in your browser, but parts of the Platform may then not work.",
          "Third parties such as payment, maps and advertising providers may set their own cookies under their own policies.",
        ],
      },
    ],
  },
  {
    id: "accounts",
    title: "5. Accounts and access",
    sections: [
      {
        id: "account-basics",
        title: "5.1 Your account",
        paragraphs: [
          "You must be 18 or older and able to enter a contract. One person, one account. You may hold more than one role on that account (for example buyer and owner) and switch between them. Each licence (for example an agent licence) belongs to one user and cannot be shared between accounts.",
          "We may require a verified email, a verified mobile, multi-factor sign-in, and extra checks before you can use some features.",
        ],
      },
      {
        id: "verification",
        title: "5.2 Verification",
        paragraphs: [
          "Anyone can sign up and browse. The first time you contact a seller, make an offer or apply for a rental, we require a full identity check, done once and reused. Owners and posters must complete the checks we require before publishing. Agents must hold a current licence in the state they act in. Business buyers need an active ABN that matches the business name and proof of authority.",
          "A verified badge means a check was done at a point in time. It is not a guarantee about the person.",
        ],
      },
      {
        id: "roles",
        title: "5.3 Role-specific terms",
        paragraphs: [
          "Buyers and renters: your enquiries, offers and applications are real; offers made through the Platform are not binding until the parties sign a contract. Do not make an offer you cannot support. Do not share a seller's details or documents without permission.",
          "Owners: you are responsible for your listing, for any disclosure and compliance documents required in your state, for a lawful price description, and for choosing who you deal with. You decide on every offer. Only you may approve go-live.",
          "Agents: you must hold the licence you declare, act within the scope the owner appoints, and tell us at once if your licence changes. We may suspend an agent whose licence lapses. Appointments and invitations cannot be deleted.",
          "Contractors (photographers, inspectors, solicitors and similar): you must be approved before you work on a listing, hold any licence or insurance your work needs, and upload only the file types allowed for your role. Your work is recorded in the listing's permanent record.",
          "Investors and project owners: investor interest is non-binding and available only to people who have made the investor declaration. Project posters must give accurate information and must not use the Platform to take money from investors. Nothing on the Platform is an offer to invest or advice about investing.",
        ],
      },
      {
        id: "termination",
        title: "5.4 Suspension and termination",
        paragraphs: [
          "You can close your account at any time, subject to settling any open fees and any transaction in progress.",
          "We may suspend or end your access, remove content or refuse service if you break these terms or the law, give false information, fail a required check, abuse other users or staff, put the Platform at risk, or are not paying amounts due. If we can reasonably do so we will tell you why and let you respond, except where we must act urgently or the law prevents it.",
          "On termination you lose access, unpaid fees remain payable, permanent records stay (3.4), and clauses that by their nature continue (including 3, 6 and 7) survive.",
        ],
      },
    ],
  },
  {
    id: "disputes",
    title: "6. Disputes, liability and law",
    sections: [
      {
        id: "contact",
        title: "6.1 Contact and complaints",
        paragraphs: [
          `Send complaints, notices and requests to ${TERMS_CONTACT}. We will acknowledge within 5 business days and try to resolve it within 30 days.`,
        ],
      },
      {
        id: "process",
        title: "6.2 Dispute process",
        paragraphs: [
          "If you have a dispute with us, first give us written notice and 30 days to resolve it. If it is not resolved, the parties will try in good faith to settle it through mediation with an independent mediator before starting court proceedings, unless urgent relief is needed.",
          "Disputes between users (for example owner and buyer, or owner and contractor) are between them. We may help by providing records from the Platform where the law allows, but we do not decide or guarantee the outcome.",
        ],
      },
      {
        id: "liability",
        title: "6.3 Limitation of liability",
        paragraphs: [
          "To the extent the law allows, and except for your rights under the Australian Consumer Law that cannot be excluded: the Platform and everything on it is provided as is; we do not accept liability for the accuracy of user content, listings, AI output, price suggestions or reports, or for the acts, omissions, licensing or solvency of any user, agent, contractor, solicitor or trustee; and we are not liable for indirect or consequential loss, loss of profit, loss of opportunity, or loss of data.",
          "Where our liability for a breach of a consumer guarantee can be limited by law, we limit it, at our option, to supplying the service again or paying the cost of having it supplied again.",
          "Subject to that, our total liability to you for all claims arising from your use of the Platform in any 12 months is limited to the fees you paid us in those 12 months.",
          "Nothing in these terms excludes liability for death or personal injury caused by us, fraud, or anything that cannot be excluded by law.",
        ],
      },
      {
        id: "indemnity",
        title: "6.4 Your responsibility for your content and conduct",
        paragraphs: [
          "You are responsible for loss we or other users suffer because you broke these terms or the law, posted unlawful or infringing content, or gave false information, to the extent permitted by law.",
        ],
      },
      {
        id: "law",
        title: "6.5 Governing law",
        paragraphs: [
          `These terms are governed by the law of ${TERMS_GOVERNING_STATE}, Australia and the Commonwealth. The parties submit to the non-exclusive jurisdiction of the courts of ${TERMS_GOVERNING_STATE} and the Commonwealth. Rules that apply to a particular property (for example disclosure, cooling-off and trust account rules) are those of the state or territory where the property is.`,
        ],
      },
    ],
  },
  {
    id: "general",
    title: "7. General",
    sections: [
      {
        id: "changes",
        title: "7.1 Changes to these terms",
        paragraphs: [
          "We may update these terms. Each version has a number and an effective date. If a change is material we will tell you in advance and ask you to accept the new version before you post or take other key actions. If you do not accept it, you can still browse and close your account.",
        ],
      },
      {
        id: "other",
        title: "7.2 Other terms",
        paragraphs: [
          "These terms are the whole agreement between you and us about the Platform. If a part is unenforceable the rest still applies. A failure to enforce a right is not a waiver. You may not transfer your rights without our consent. We may transfer ours with notice. We are not liable for delay caused by events outside our reasonable control. Notices to you may be sent to your account email or shown in the Platform.",
          "Translations are for convenience only. If a translation differs from the English version, the English version applies.",
        ],
      },
    ],
  },
];

/** Short summary shown at the top of the page, before the full text. */
export const TERMS_SUMMARY: readonly string[] = [
  "The platform holds no money. Deposits go to the solicitor's trust account.",
  "AI helps with replies and reports, but only you decide on offers. AI never accepts an offer.",
  "No commission on house sales or rentals: owners pay a flat fee per listing package.",
  "Chat messages and published files are kept permanently and cannot be deleted.",
  "We collect personal information only as needed and handle it under the Privacy Act.",
];
