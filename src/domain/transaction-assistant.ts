import { CONTACT_RE, fenceData, BASE_SYSTEM_PROMPT, isEngineUsable, type AiEnginePort } from "./ai-engine";
import type { DocumentKind } from "./documents";
import { summariseFindings, type Finding, type InspectionKind, type InspectionStatus } from "./inspection";

/**
 * The assistant (Elena by default) for the transaction pages: inspections, documents and signing. Rule based and deterministic.
 * Each question goes to a specialist "desk" (inspection, documents, signing, terms, insights); the desk is shown with the answer.
 * She explains and suggests. She gives no legal, financial or valuation advice, never signs, accepts or sends anything for anyone,
 * and only uses facts the asking person can already see. Questions are not stored. Pure functions.
 */
export const DESKS = ["inspection", "documents", "signing", "terms", "insights", "general"] as const;
export type Desk = (typeof DESKS)[number];
export const DESK_LABELS: Record<Desk, string> = {
  inspection: "Inspection desk", documents: "Documents desk", signing: "Signing desk", terms: "Terms desk", insights: "Insights desk", general: "Elena"
};

export type Stage = "preparing" | "marketing" | "offer" | "contract";
export const STAGE_LABELS: Record<Stage, string> = {
  preparing: "Preparing the listing", marketing: "On the market", offer: "Offer under review", contract: "Offer accepted"
};
export type Viewer = "owner" | "agent" | "buyer" | "inspector";

export interface TxnFacts {
  viewer: Viewer;
  transactionType: "sale" | "rent";
  stage: Stage;
  jurisdiction: string;
  uploadedKinds: readonly DocumentKind[];
  /** Templates made on this listing and where each stands. */
  generated: readonly { templateId: string; state: "draft" | "awaiting_signature" | "signed" }[];
  inspections: readonly { kind: InspectionKind; status: InspectionStatus }[];
  findings: readonly Finding[];
  awaitingMySignature: number;
}

export const MAX_QUESTION = 300;

export function stageOf(listingStatus: string, offer: "none" | "active" | "accepted"): Stage {
  if (offer === "accepted") return "contract";
  if (offer === "active") return "offer";
  return listingStatus === "published" ? "marketing" : "preparing";
}

export interface Requirement { key: string; label: string; why: string; priority: "required" | "recommended"; done: boolean; href: "documents" | "transaction" | "inspections" }

/** What the transaction should hold at this stage, and what is already there. */
export function requirements(f: TxnFacts): Requirement[] {
  const has = (k: DocumentKind) => f.uploadedKinds.includes(k);
  const tpl = (id: string, need: "any" | "signed") => f.generated.some(g => g.templateId === id && (need === "any" || g.state === "signed"));
  const inspected = (k: InspectionKind) => f.inspections.some(i => i.kind === k && i.status === "completed");
  const out: Requirement[] = [];
  const rentOnly = f.transactionType === "rent";
  out.push({ key: "contract", label: rentOnly ? "Lease agreement" : "Contract of sale", priority: "required", href: "documents", done: has("contract"),
    why: rentOnly ? "Your solicitor or agent prepares the lease. Upload it as a contract." : "Your solicitor or conveyancer prepares the contract of sale. Upload it as a contract." });
  if (!rentOnly) {
    out.push({ key: "title_search", label: "Title search", priority: "required", href: "documents", done: has("title_search"),
      why: "Shows who owns the property and what is registered against it." });
    out.push({ key: "seller_disclosure_summary", label: "Seller disclosure summary", priority: "recommended", href: "transaction", done: tpl("seller_disclosure_summary", "any"),
      why: "Puts what you know about the property on record. It sits beside the statutory disclosures your solicitor prepares." });
  }
  if (f.stage !== "preparing") {
    out.push({ key: "building_inspection", label: "Building inspection report", priority: "recommended", href: "inspections", done: has("building_inspection") || inspected("building"),
      why: "Lets a buyer see the condition of the building before they make an offer." });
    out.push({ key: "pest_report", label: "Pest inspection report", priority: "recommended", href: "inspections", done: has("pest_report") || inspected("pest"),
      why: "Records any termite or pest activity." });
  }
  if (f.stage === "contract" && !rentOnly) {
    out.push({ key: "purchase_heads_of_terms", label: "Signed purchase heads of terms", priority: "recommended", href: "transaction", done: tpl("purchase_heads_of_terms", "signed"),
      why: "Records the agreed price, deposit and settlement before the contract of sale is exchanged." });
    out.push({ key: "deposit_trust_notice", label: "Signed deposit and trust account notice", priority: "required", href: "transaction", done: tpl("deposit_trust_notice", "signed"),
      why: "The buyer confirms the deposit goes to the solicitor's trust account." });
  }
  return out;
}

export const missingDocuments = (f: TxnFacts): Requirement[] => requirements(f).filter(r => !r.done);

export interface Insights { completenessPct: number; requiredMissing: number; recommendedMissing: number; findings: ReturnType<typeof summariseFindings>["bySeverity"]; inspectionsOpen: number; awaitingMySignature: number }

/** Simple counts for the page header: how complete the paperwork is and what needs attention. */
export function insights(f: TxnFacts): Insights {
  const reqs = requirements(f);
  const done = reqs.filter(r => r.done).length;
  return {
    completenessPct: reqs.length === 0 ? 100 : Math.round((done / reqs.length) * 100),
    requiredMissing: reqs.filter(r => !r.done && r.priority === "required").length,
    recommendedMissing: reqs.filter(r => !r.done && r.priority === "recommended").length,
    findings: summariseFindings(f.findings).bySeverity,
    inspectionsOpen: f.inspections.filter(i => i.status === "requested" || i.status === "confirmed").length,
    awaitingMySignature: f.awaitingMySignature
  };
}

export interface Term { id: string; names: RegExp; name: string; text: string }
const TERM_NOTE = " The rules differ by state, so check with your solicitor or conveyancer.";
export const GLOSSARY: readonly Term[] = [
  { id: "cooling_off", name: "Cooling-off period", names: /cooling[- ]?off/i, text: "A short period after a contract is signed, in some states and some sales, when the buyer may be able to withdraw, usually by paying a small penalty. Whether it applies, and for how long, is set by the state law and the contract." + TERM_NOTE },
  { id: "deposit", name: "Deposit", names: /\bdeposits?\b/i, text: "Part of the price the buyer pays when the contract is made, as a sign of good faith. It is paid to a solicitor's or conveyancer's trust account, never to this website." + TERM_NOTE },
  { id: "settlement", name: "Settlement", names: /settle(ment)?\b/i, text: "The day ownership passes: the buyer pays the balance, the title is transferred and the buyer gets the keys. The contract sets the date." },
  { id: "disclosure", name: "Seller disclosure", names: /disclos/i, text: "Information the seller must give the buyer before or when a contract is made, such as title details and certain certificates. Your solicitor prepares the statutory forms; the summary on this site adds what you know about the property." + TERM_NOTE },
  { id: "title_search", name: "Title search", names: /title( search)?/i, text: "A search of the land registry showing the registered owner, mortgages, easements and other interests on the property." },
  { id: "inspection", name: "Building and pest inspection", names: /(building|pest)( and| &)?( pest)? ?inspect|inspection report/i, text: "A licensed inspector checks the structure, and separately for termites and pests, and writes a report. Findings are rated by how serious they are so you can see what matters most." },
  { id: "subject_to_finance", name: "Subject to finance", names: /subject to (finance|loan)|finance (clause|condition)/i, text: "A condition that the buyer's loan must be approved by a set date, otherwise the buyer may be able to end the contract. It is written into the contract." + TERM_NOTE },
  { id: "special_conditions", name: "Special conditions", names: /special condition|conditions? of (the )?contract/i, text: "Extra terms added to a standard contract, for example a requirement for repairs or a particular settlement arrangement. Read them with your solicitor." },
  { id: "contract_of_sale", name: "Contract of sale", names: /contract of sale|sale contract|\bcontract\b/i, text: "The legally binding agreement between the seller and buyer. Your solicitor or conveyancer prepares and explains it. The terms sheet on this site is not a contract." },
  { id: "heads_of_terms", name: "Heads of terms", names: /heads of terms|terms sheet|subject to contract/i, text: "A short list of the main terms two sides have talked about, written before the contract. 'Subject to contract' means neither side is bound until the contract of sale is signed and exchanged." },
  { id: "trust_account", name: "Trust account", names: /trust account/i, text: "A bank account a solicitor, conveyancer or agent holds on behalf of others. Deposits go here so the money is protected until settlement. This website never holds money." },
  { id: "e_signature", name: "Electronic signature", names: /e-?sign|electronic(ally)? sign|digital signature|docusign/i, text: "You sign by agreeing to sign electronically and typing your full name. We record the document, your name, the time and the consent wording. Some documents, for example certain land contracts, may still need a different signing method; your solicitor will tell you." }
];

const DECISION = String.raw`should (i|we) (sign|accept|buy|sell|pay|waive|reject|decline|counter|offer|agree|proceed|go ahead|withdraw|negotiate|take|walk|renegotiate)`;
const ADVICE = new RegExp(String.raw`\b${DECISION}\b|\b(is|are) (it|this|that|these) (legal|enforceable|binding|safe|fair|worth)|\b(worth|too much|too high|too low|good price|bad price|negotiate|waive|sue|liable|liability)\b|legal advice|tax advice`, "i");
const PRIVACY = /\b(phone|mobile|email|address|number|surname|last name|who is|bank|account details|password|id document)\b.*\b(buyer|seller|owner|inspector|agent|signer|they|him|her)\b|\b(buyer|seller|owner|inspector|agent)\b.*\b(phone|mobile|email|contact details|bank|account details)\b/i;
export const ADVICE_ANSWER = "I can't give legal, financial, tax or valuation advice, or say whether to sign, buy, sell or accept. A solicitor or conveyancer can advise on your contract. I can explain what a term means, what documents are usually needed, and what your inspection report says.";
export const PRIVACY_ANSWER = "I can't share anyone's contact or bank details. Use the secure chat on the listing to reach the other party, and confirm payment details by phone with the solicitor or conveyancer.";
const UNKNOWN_ANSWER = "Sorry, I didn't catch that. Ask me what documents are missing, what a term means, what the inspection found, or what to do next.";

export interface TxnAnswer { desk: Desk; topic: string; pose: "wave" | "tablet" | "front" | "three-quarter"; text: string; suggestions: string[] }

const DEFAULT_SUGGESTIONS = ["What documents are missing?", "What should I do next?", "Summarise the inspection findings", "What does 'subject to contract' mean?"];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function nextStepsText(f: TxnFacts): string {
  const steps: string[] = [];
  if (f.awaitingMySignature > 0) steps.push(`Read and sign the ${plural(f.awaitingMySignature, "document")} waiting for you.`);
  const miss = missingDocuments(f);
  const req = miss.filter(m => m.priority === "required");
  if (req.length > 0) steps.push(`Add the required ${req.length === 1 ? "document" : "documents"}: ${req.map(r => r.label.toLowerCase()).join(", ")}.`);
  const open = f.inspections.filter(i => i.status === "requested" || i.status === "confirmed").length;
  if (open > 0) steps.push(`${plural(open, "inspection")} still to be completed.`);
  const sum = summariseFindings(f.findings);
  if (sum.bySeverity.urgent + sum.bySeverity.major > 0) steps.push("Look at the urgent and major inspection findings first.");
  if (steps.length === 0) steps.push(`Nothing is waiting at the "${STAGE_LABELS[f.stage].toLowerCase()}" stage. Check the recommended documents if you want a fuller record.`);
  return steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
}

/** Picks a desk and builds the answer from the facts. */
export function answerQuestion(f: TxnFacts, question: string): TxnAnswer {
  const q = question.normalize("NFKC").slice(0, MAX_QUESTION);
  const done = (desk: Desk, topic: string, text: string, pose: TxnAnswer["pose"] = "tablet", suggestions = DEFAULT_SUGGESTIONS): TxnAnswer => ({ desk, topic, pose, text, suggestions });
  if (!q.trim()) return done("general", "unknown", UNKNOWN_ANSWER, "front");
  if (PRIVACY.test(q)) return done("general", "privacy", PRIVACY_ANSWER, "front");
  const term = GLOSSARY.find(t => t.names.test(q));
  const asksMeaning = /\b(what (is|are|does)|mean|explain|define)\b/i.test(q);
  if (ADVICE.test(q) && !(term && asksMeaning && !new RegExp(String.raw`\b${DECISION}\b`, "i").test(q))) return done("general", "advice", ADVICE_ANSWER, "front");
  if (/missing|need(ed)?\b.*(document|paper)|which documents|what documents|required documents/i.test(q)) {
    const miss = missingDocuments(f);
    if (miss.length === 0) return done("documents", "documents_complete", `Everything usual for the "${STAGE_LABELS[f.stage].toLowerCase()}" stage is on record.`);
    return done("documents", "documents_missing",
      `For the "${STAGE_LABELS[f.stage].toLowerCase()}" stage, these are still missing:\n` +
      miss.map(m => `- ${m.label} (${m.priority}): ${m.why}`).join("\n"), "tablet", ["What should I do next?", "Summarise the inspection findings"]);
  }
  if (/next step|what next|what now|what should i do|where (do|am) i/i.test(q)) return done("general", "next_steps", `Here is what to do next:\n${nextStepsText(f)}`, "wave");
  if (/inspect|finding|report|defect|termite|pest/i.test(q) && !(term && asksMeaning && !/finding|report|defect/i.test(q))) {
    if (f.findings.length === 0) {
      const open = f.inspections.filter(i => i.status !== "cancelled" && i.status !== "completed").length;
      return done("inspection", "no_findings", open > 0 ? `No findings are recorded yet. ${plural(open, "inspection")} still to be completed.` : "No inspection findings are recorded on this listing yet. You can book an inspection from the inspections page.");
    }
    const s = summariseFindings(f.findings);
    const top = s.priorities.slice(0, 5).map(p => `- ${p.severity.toUpperCase()} · ${p.area}: ${p.summary}`);
    return done("inspection", "findings", [s.headline, ...(top.length ? ["Most important:", ...top] : []), ...s.nextSteps.map(n => `• ${n}`),
      "I report what the inspector wrote. I can't say what a repair costs or whether to buy."].join("\n"), "tablet");
  }
  if (/sign|signature|waiting for me|e-?sign/i.test(q) && !term?.id.startsWith("e_") ) {
    return done("signing", "signing", f.awaitingMySignature > 0
      ? `You have ${plural(f.awaitingMySignature, "document")} to sign. Open it, read it all, tick the consent box and type your full name. You can decline instead, and your answer is final once given.`
      : "Nothing is waiting for your signature. When an owner sends you a document to sign, it shows here and you get an email.", "tablet", DEFAULT_SUGGESTIONS);
  }
  if (/progress|overview|summary|how complete|percent|stats|analy[sz]e|insight/i.test(q)) {
    const i = insights(f);
    return done("insights", "insights", [`Paperwork is ${i.completenessPct}% complete for this stage.`, `Required documents missing: ${i.requiredMissing}. Recommended missing: ${i.recommendedMissing}.`,
      `Inspections still open: ${i.inspectionsOpen}.`, `Findings: ${i.findings.urgent} urgent, ${i.findings.major} major, ${i.findings.minor} minor, ${i.findings.info} for information.`,
      `Waiting for your signature: ${i.awaitingMySignature}.`].join("\n"), "tablet");
  }
  if (term) return done("terms", `term_${term.id}`, `${term.name}: ${term.text} This is general information, not legal advice.`, "three-quarter", ["What documents are missing?", "What should I do next?"]);
  return done("general", "unknown", UNKNOWN_ANSWER, "front");
}

// ---- Optional AI summary of the inspection findings (self-hosted engine only; fails closed) ----
export type AiFindingsSummary = { state: "ready"; text: string; note: string } | { state: "unavailable"; message: string } | { state: "not_requested" };
export const FINDINGS_AI_NOTE = "AI summary of what the inspector wrote. Check it against the report.";
const FINDINGS_AI_UNAVAILABLE = "The AI summary is not available right now. The table above is complete.";
const FORBIDDEN_OUTPUT = /\b(you should|i recommend|buy|don't buy|do not buy|negotiate|offer (a )?lower|worth|\$\s?\d|\d+\s?dollars)\b/i;

export function buildFindingsPrompt(findings: readonly Finding[]): string {
  const lines = findings.slice(0, 50).map(f => `${f.severity} | ${f.area} | ${f.summary}`).join("\n");
  return [
    "Summarise these building inspection findings in at most 120 words of plain English for a home owner.",
    "Mention the urgent and major items first. Do not give advice, costs or opinions on buying.",
    fenceData(lines, 6000)
  ].join("\n");
}

export function checkFindingsSummary(text: string): boolean {
  return text.length >= 20 && text.length <= 1200 && !CONTACT_RE.test(text) && !FORBIDDEN_OUTPUT.test(text) && !/<{2,}|DATA>>>/.test(text);
}

export async function requestFindingsSummary(engine: AiEnginePort, findings: readonly Finding[]): Promise<AiFindingsSummary> {
  const unavailable: AiFindingsSummary = { state: "unavailable", message: FINDINGS_AI_UNAVAILABLE };
  if (findings.length === 0 || !isEngineUsable(engine)) return unavailable;
  try {
    const text = (await engine.generate(buildFindingsPrompt(findings), { system: BASE_SYSTEM_PROMPT, maxTokens: 300 })).trim();
    return checkFindingsSummary(text) ? { state: "ready", text, note: FINDINGS_AI_NOTE } : unavailable;
  } catch {
    return unavailable;
  }
}
