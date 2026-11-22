# Questions for Australian counsel

Please advise in writing on each point. Most apply in every state where the platform will operate.

## 1. Licensing and the role of the platform
1. Does the platform act as an estate agent when owners sell themselves using AI-assisted tools, or when an owner appoints a licensed agent on a listing?
2. Is the appointed-agent model (owner approves every offer, agent handles enquiries) compliant in each state?
3. Can the AI send replies to enquirers on the owner's behalf from owner-approved templates after a review window?

## 2. Financial and credit advice
4. Where is the line between general information and personal credit assistance or financial product advice for the public buyer AI? Are the planned rules enough (no specific loan, lender or personal amount, plus a disclaimer)?
5. Broker introductions: what licences and disclosures are needed if the platform is paid for referrals?
6. Can the professional AI be used by a broker under their own credit licence? What are the broker's duties for AI-assisted work?

## 3. Contracts and legal work
7. Does AI-filled contract drafting from a solicitor-approved template count as legal practice in each state? What review by solicitors is required before signing?
8. Which documents can be signed electronically, and which need witnessing or a deed?
9. Review of our terms of use, liability limits and unfair contract term risks.

## 4. Trust accounts and deposits
10. Is our trust-account verification process adequate (practising certificate check, firm email confirmation, account name check, bank letter, call-back, person approval)?
11. What duties or liability does the platform have if a trust account is wrong or payment redirection fraud occurs? Does displaying trust account details create duties?
33. Sale fell through, state rules (src/domain/sale-fall-through.ts STATE_RULES, version 2026-11-05-owner-accepted, live since the owner chose on 5 Nov 2026 to run it without counsel review; every figure was written from memory and is NOT confirmed, and the screens say so). Please confirm, per state, the cooling-off right and penalty we use. QLD, NSW and ACT: 5 business days, 0.25% of the price kept by the seller. VIC: 3 business days, 0.2% or $100, whichever is greater. SA: 2 business days. NT: 4 business days. WA and TAS: none. For SA and NT we do not know the penalty, so the estimate takes none and says so. Are these right, and are there exceptions (auction, missing vendor statement or notice, buyer waived the period or took advice first)?
34. Cooling-off clock: we count weekdays after the day the owner accepts the offer on the platform, up to the day the buyer raises it, and do not exclude public holidays. When does the period really start (signing, exchange, service of the contract or certificate), what is a business day in each state, and does the day of acceptance count?
35. Penalty: is it the seller's entitlement out of the deposit held in trust, can the parties agree a different split, and may we show a platform estimate to both sides without it being treated as legal advice?
36. Conditions (finance, building and pest, other): we propose a full refund when a condition is not met on the buyer's say-so, and staff check dates and notices before paying. Who decides that a condition was not satisfied, waived or deemed satisfied, and what evidence should staff ask for before a refund is approved?
37. Defaults: when the owner says the buyer defaulted we propose that the seller keeps the whole deposit held in trust; when the buyer says the seller defaulted we propose a full refund. Is that right where the contract caps the forfeit (for example 10% of the price) or needs a notice to complete first? What must precede a default for it to count?
38. Disputes: a dispute freezes the deposit until staff record an agreement between the parties or a court order, and a second staff member approves each payment. Is that enough for the solicitor to pay out of trust, or must the solicitor hold a signed instruction or release from both parties?
39. When both sides agree, the offer is marked fallen through and its sold event is voided from market data. Is there any duty to tell the listing agent, a mortgagee or a later buyer, and how long must we keep the case record?

## 5. Privacy and data
12. Is acceptance of terms enough for AI learning from de-identified negotiation data, or is separate consent needed? What de-identification standard should we meet?
13. Retention schedule for chat history, documents, contracts and identity or financial details. How should deletion requests be handled when records are permanent?
14. Storing buyers' financial details, and hosting or AI processing outside Australia (cross-border disclosure).
15. Data breach response readiness (notifiable data breaches).

## 6. Fair treatment
16. Applicant-strength analysis: which factors are lawful to use? Confirm exclusion of protected attributes.
17. Suburb suggestions for buyers: confirm our approach avoids steering by demographics.

## 7. Marketing and listing content
18. Email and SMS alerts: consent and unsubscribe duties under the Spam Act, and Do Not Call rules.
19. AI-written property descriptions: responsibility for accuracy, misleading conduct risk, and our rules on reports and absolute claims.
20. Photographer and contractor terms: who owns photos and videos, and what licence do we need to reuse them?

## 8. Future property-data business
21. Can listing and sale data be reused in a separate property-data product? What consents do we need from owners and buyers?
22. Licensing terms for third-party data (title, valuation, suburb reports) and limits on reuse.

## 9. Investment module (later)
23. Confirm the pathway before Gate G4 (wholesale only, a licensed partner, or our own licence).
23a. Investor projects module (built, OFF): owners post property projects; verified investors express non-binding interest and chat; the platform holds no money and takes no investment. Does posting and showing these projects amount to dealing, arranging or advising under the Corporations Act, needing an AFSL or an authorised-representative arrangement? Does crowd-sourced funding (Part 6D.3A) apply, or any other exemption?
23b. Wholesale and sophisticated investor tests (s708(8), (10), (11), s761G): is a self-declaration enough to show wholesale-only projects, or must we see an accountant's certificate or other evidence? Which investor categories may see which projects, and may retail investors see anything at all?
23c. Advertising and hawking restrictions (s734, s736, s992A): can projects be visible to logged-in verified investors only, and what may appear in nav, emails and the home page? The module currently shows nothing until both switches are on. Once on, the owner wants every approved project listed publicly (anyone, signed out included): title, location, type, stage, summary, indicative target and minimum, and issuer name. Risks, structure, contact, interest and contract terms stay with declared investors. Is this public listing an advertisement of an offer, and what must change for it to be allowed?
23d. Replace the DRAFT general risk warning (src/config/investment-disclosure.ts) and say what disclosure text each project needs (information memorandum, issuer details). Can we mask contact details in the issuer statement, or must the issuer's identity always be shown?
23e. Commission model (Model 1): a platform fee, a percentage of the amount in the signed contract, invoiced to the poster after the signed contract is returned through us. Review for AFSL / financial-services rules (conflicted remuneration, success fees), state finder-fee and intermediary laws, and real estate agent licensing. Model 2: an upfront posting fee. **The module stays OFF until counsel has reviewed both models.**
23f. Replace the DRAFT "Investor introduction and fee agreement" (src/config/investment-contract.ts). Is it right that the investor uploads the signed copy to us and staff confirm it? Retention of these files (kept permanently now)?
23g. Contact masking: we hide emails, phone numbers and links in chat until Model 2 disclosure unlocks, and relay notices by email from the platform address. Any consumer-law, Spam Act or privacy issue with this, and what should the privacy notice say?

## 10. Offers on the platform
24. Review the offer form wording and the automated "formal, final offer" prompt. Confirm that an offer submitted on the platform creates no binding obligation, and whether cooling-off, "subject to contract" or deposit wording is needed in each state.

## 11. Buyer identity checks
25. The AML/CTF reforms now extend to real estate professionals. Does the platform itself have any obligations (customer due diligence, reporting), or only the agents and solicitors who use it? Does our ID check help them meet theirs?
26. The ID check uses a live selfie. Confirm how biometric information must be collected, consented to, held (we plan to keep only the provider's result reference) and deleted under the Privacy Act.
27. Owner reports about buyers: what process and wording keeps a buyer flag fair and defensible?
28. Interim in-house ID review: confirm we may hold ID images and selfies briefly for review, the retention periods (7 days after approval, 30 after rejection), reviewer access controls, and any notice or consent wording needed.


## 12. E-signing and DocuSign
See `docs/COUNSEL_ESIGN_BRIEF.md`.
29. Is our built-in click-to-sign (logged-in account, typed name matching the account, consent tick, hashed text, insert-only audit trail with IP and time) a valid electronic signature under the Electronic Transactions Act and state equivalents for the document types we offer? Which types, if any, must use a hosted provider such as DocuSign instead?
30. Which documents need a witness, deed execution or notary, and is remote witnessing allowed in each state? Is a witness role on a template enough, or must it be excluded?
31. Retention and deletion of signed documents and audit trails: how long must we keep them, and may we refuse account deletion for them? What must we tell the user, and what does DocuSign's retention and data residency mean for our privacy notice?
32. Signer verification: is account login plus email enough, or must we add phone code or ID check per document type? What wording is needed for consent, decline, expiry and non-signing?

## 13. Transaction templates, second e-signing path and assistant
40. The transaction pages add a second built-in signing path (separate from the one in section 12); please confirm both are acceptable or which should stay. It is built in (typed full name, consent wording, document SHA-256, time, hashed IP, evidence hash; src/domain/e-sign.ts). Is that enough under the Electronic Transactions Acts for the four templates (inspection access consent, seller disclosure summary, purchase heads of terms, deposit and trust notice)? Which documents, if any, must NOT be signed this way (for example a land contract of sale or a lease over a set term) in QLD first, then WA, NSW, VIC? DocuSign or a similar provider can replace the built-in method if counsel prefers; nothing else changes.
41. Review the template wording in src/domain/document-templates.ts. They avoid any statutory period or amount on purpose (cooling-off, disclosure forms) and say the heads of terms are "subject to contract". Confirm that is safe, and what a solicitor-supplied contract of sale must still be uploaded separately.
42. Retention of signed documents, signing evidence (kept permanently now, insert-only). Retention period, and handling of a deletion request from an account holder who signed.
43. The assistant explains terms from a fixed glossary. Confirm the wording of the glossary (src/domain/transaction-assistant.ts) is general information and not advice.

