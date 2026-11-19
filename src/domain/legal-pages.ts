/** Text of the public /privacy, /terms and /support pages. DRAFT: needs review by Australian counsel before launch. */
import { readBrand, DEFAULT_SUPPORT_EMAIL } from "../config/brand";

const BRAND = readBrand().name;
import { RECOVERY_DAYS, RETENTION_YEARS } from "./account-deletion";

export interface LegalSection { id: string; heading: string; paragraphs: string[]; bullets?: string[] }
export interface LegalDoc { title: string; updated: string; intro: string; sections: LegalSection[] }

/** Shown at the top of every legal page until counsel signs off. */
export const LEGAL_DRAFT_NOTICE = "Draft for legal review. This text has not yet been reviewed by Australian counsel and may change before launch.";
export const LEGAL_UPDATED = "18 November 2026";
/** PLACEHOLDER address until the real support mailbox exists; set SUPPORT_EMAIL to override. */
export const supportEmail = (env: Record<string, string | undefined> = process.env): string => env["SUPPORT_EMAIL"]?.trim() || DEFAULT_SUPPORT_EMAIL;

export const PRIVACY: LegalDoc = {
  title: "Privacy policy",
  updated: LEGAL_UPDATED,
  intro: `${BRAND} helps Australian owners sell or rent their own property. This policy explains what personal information we collect, why, who sees it and how you can access, correct or delete it. We handle personal information under the Privacy Act 1988 (Cth) and the Australian Privacy Principles (APPs).`,
  sections: [
    { id: "collect", heading: "What we collect", paragraphs: ["We collect only what we need to run the service (APP 3)."], bullets: [
      "Account details: name, email address, phone number, and the sign-in method you choose (email or Google).",
      "Verification details where a feature needs them, such as buyer verification, licence details for agents and ABN for businesses. Identity documents are used only for verification.",
      "Listing content: addresses, descriptions, photos, floor plans and documents you upload.",
      "Activity: enquiries, offers, inspection bookings, saved searches and messages you send on the platform.",
      "Technical data: device type, app version, push notification tokens, and logs needed to keep the service secure."] },
    { id: "use", heading: "How we use it", paragraphs: ["We use personal information to provide listings, enquiries, offers and inspections; to verify accounts; to send notices you need (such as offer and security emails); to prevent fraud and abuse; and to meet legal obligations. We use it for marketing only if you opt in, and you can opt out at any time."] },
    { id: "ai", heading: "AI assistance", paragraphs: ["AI features, such as the Elena assistant, run on our own infrastructure and do not send your content to an external AI provider. AI helps with drafts and reports. It never accepts or rejects an offer; only the owner decides."] },
    { id: "share", heading: "Who sees it", paragraphs: ["Your listing is public by design. Your contact details are shared only with people you deal with on the platform, for example an owner and a verified buyer who make an offer. We use service providers for hosting, email, SMS and push delivery, maps, and identity checks. They may use your information only to provide those services to us. Solicitors and conveyancers you appoint receive the information needed for the transaction. We do not sell personal information."] },
    { id: "trust", heading: "Money", paragraphs: ["The platform does not hold your money. Deposits go to the solicitor's trust account. Where a hosted payment provider is used, card details go to that provider and are not stored by us."] },
    { id: "overseas", heading: "Overseas disclosure", paragraphs: ["Some providers may store or process information outside Australia. Before launch we will list the countries here (APP 8). Until then this section is a placeholder."] },
    { id: "messages", heading: "Messages and published files", paragraphs: ["Chat messages and published files form part of the record of a property transaction. They are kept and cannot be deleted by users, even if an account is later closed. Personal details attached to your account are removed or de-identified as set out under Deleting your data."] },
    { id: "retention", heading: "Keeping and deleting your data", paragraphs: [
      `You can ask us to delete your account. For ${RECOVERY_DAYS} days we can restore it if you change your mind. After that the deletion is final. Offers, invoices and audit history are kept for ${RETENTION_YEARS} years for legal and tax reasons, then your name, email and sign-in details are removed.`,
      "To start a deletion request, contact support from the address on your account."] },
    { id: "rights", heading: "Access, correction and complaints", paragraphs: ["You can ask for a copy of your personal information or ask us to correct it (APPs 12 and 13). We respond within 30 days. If you are unhappy with how we handled your information, contact support and we will investigate. You can also complain to the Office of the Australian Information Commissioner at oaic.gov.au."] },
    { id: "security", heading: "Security", paragraphs: ["We protect information with access controls, encryption in transit, audit logging and staff-only admin tools. No system is perfectly secure. If a breach is likely to cause serious harm we will notify you and the OAIC as the Notifiable Data Breaches scheme requires."] },
    { id: "children", heading: "Children", paragraphs: [`${BRAND} is for people aged 18 and over. We do not knowingly collect information from children.`] },
    { id: "changes", heading: "Changes", paragraphs: ["We will update this page when our practices change and show the date at the top. For material changes we will also notify account holders."] }
  ]
};

export const TERMS: LegalDoc = {
  title: "Terms of use",
  updated: LEGAL_UPDATED,
  intro: `These terms govern your use of ${BRAND}, a marketplace where owners list their own property and deal directly with buyers and renters. By creating an account you agree to them.`,
  sections: [
    { id: "service", heading: `What ${BRAND} is`, paragraphs: [`${BRAND} is a platform. We are not your real estate agent, solicitor or financial adviser, and we are not a party to any sale or lease. Prices, guides and AI output are information only, not valuations or advice. Get independent legal and financial advice.`] },
    { id: "licence", heading: "Your account and licence", paragraphs: ["You must be 18 or over and give accurate information. One licence covers one user. You may not share a licence or account with other people, and we may suspend accounts that do. Keep your sign-in details secure; you are responsible for activity on your account."] },
    { id: "listings", heading: "Listings", paragraphs: ["You must own the property or be authorised to list it. Listings must be accurate, lawful and comply with state and territory laws, including required disclosures and advertising rules. Nothing publishes until required checks, including a verified solicitor trust account for sales, are complete. We may remove or refuse a listing that breaks these terms."] },
    { id: "offers", heading: "Offers and deposits", paragraphs: ["Only the owner can accept an offer, and AI never accepts one for you. The platform holds no money. Deposits go to the solicitor's trust account. A sale or lease binds the parties only through a properly executed contract."] },
    { id: "messaging", heading: "Messaging and conduct", paragraphs: ["Be respectful and honest. Chat messages and published files are kept as a record and cannot be deleted. You must not:"], bullets: [
      "post unlawful, misleading, discriminatory, harassing or abusive content;",
      "send spam or use the platform to solicit unrelated business;",
      "scrape data, probe or attack the service, or bypass its checks;",
      "impersonate another person or misrepresent a property."] },
    { id: "moderation", heading: "Content moderation", paragraphs: ["We review reports and may use automated checks. We may hide or remove content, warn, restrict or suspend an account, and report unlawful activity to authorities. Where practical we tell you why and how to respond. To report a listing, message or user, use Support."] },
    { id: "fees", heading: "Plans and fees", paragraphs: ["Fees are shown on the Plans page before you pay. Taxes such as GST are shown where they apply. Nothing in these terms limits consumer guarantees you have under the Australian Consumer Law."] },
    { id: "ip", heading: "Your content", paragraphs: ["You keep ownership of what you upload. You give us a licence to host, display and process it to run the service, including showing your listing and photos to visitors."] },
    { id: "liability", heading: "Liability", paragraphs: ["To the extent the law allows, we are not liable for loss arising from dealings between users or from information they provide. Nothing excludes liability that cannot be excluded by law."] },
    { id: "law", heading: "Governing law", paragraphs: ["These terms are governed by the law of Queensland, Australia, and the courts of Queensland. This is a placeholder pending counsel's advice."] },
    { id: "changes", heading: "Changes", paragraphs: ["When we change these terms we publish a new version and ask you to accept it before you continue using protected features."] }
  ]
};

export interface SupportTopic { id: string; question: string; answer: string }
export const SUPPORT_TOPICS: SupportTopic[] = [
  { id: "account", question: "I can't sign in", answer: "Use Forgot password on the sign-in page. If you use Google, sign in with the same Google account. If you are still locked out, email support from the address on your account." },
  { id: "delete", question: "How do I delete my account or data?", answer: `Email support from your account address and ask for deletion. You have ${RECOVERY_DAYS} days to change your mind. Offers, invoices and audit history are kept for ${RETENTION_YEARS} years; messages and published files are a permanent record. See the Privacy policy for detail.` },
  { id: "report", question: "How do I report a listing, message or user?", answer: "Email support with the listing link or the person's name and what happened. We review reports and may remove content or restrict accounts. For urgent safety concerns, call 000." },
  { id: "licence", question: "Can my team share one licence?", answer: "No. One licence covers one user. Each person needs their own account." },
  { id: "offers", question: "Where do deposits go?", answer: `Deposits go to the solicitor's trust account. ${BRAND} never holds your money.` },
  { id: "dispute", question: "I have a dispute with a buyer or owner", answer: "Open Disputes from your dashboard, or contact support. We can help the parties communicate but do not decide who is right. For legal disputes, see your solicitor or your state's fair trading office." }
];
