import { INVESTMENT_DISCLOSURE } from "../config/investment-disclosure";
import { canContactSeller, nextVerificationStep, type BuyerVerification, type VerificationStep } from "./buyer";
import type { PostingTerms } from "./investment-terms";
import { isJurisdiction, type Jurisdiction } from "./jurisdiction";
import { staffCan, type StaffActor } from "./staff-access";

/**
 * Investor projects: owners post property projects so verified investors can express non-binding interest and talk to them.
 * Pure rules. The platform holds no money, takes no investment, records no commitment and allocates nothing:
 * there are deliberately no payment, deposit, commitment or allocation fields anywhere in this module.
 */

// ---- Two-key kill switch ----

/** Master key. Anything but the exact string "true" is off (fail closed). */
export const envMasterOn = (env: Readonly<Record<string, string | undefined>>): boolean => env["INVESTMENT_MODULE_ENABLED"] === "true";

export interface ModuleState { envOn: boolean; dbOn: boolean; live: boolean }
/** Live only when both keys are on. */
export const moduleState = (envOn: boolean, dbOn: boolean): ModuleState => ({ envOn, dbOn, live: envOn === true && dbOn === true });

export interface ToggleRequest { enabled: boolean; counselConfirmed: boolean; disclosureVersion: string }
export const COUNSEL_CONFIRMATION = "Counsel has approved the investor offering documents and disclosure wording";

/** Turning ON needs investment.manage, the counsel confirmation and the current disclosure version. Turning OFF needs only the permission. */
export function decideToggle(actor: StaffActor, raw: unknown): { ok: true; value: ToggleRequest } | { ok: false; status: 400 | 403; error: string } {
  if (!staffCan(actor, "investment.manage")) return { ok: false, status: 403, error: "Not allowed." };
  const b = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!b || typeof b["enabled"] !== "boolean") return { ok: false, status: 400, error: "Say whether the module should be on or off." };
  const enabled = b["enabled"];
  const counselConfirmed = b["counselConfirmed"] === true;
  if (enabled && !counselConfirmed) return { ok: false, status: 400, error: `Tick: ${COUNSEL_CONFIRMATION}.` };
  if (enabled && b["disclosureVersion"] !== INVESTMENT_DISCLOSURE.version) {
    return { ok: false, status: 400, error: "The disclosure text changed. Reload and confirm the current version." };
  }
  return { ok: true, value: { enabled, counselConfirmed: enabled ? counselConfirmed : false, disclosureVersion: INVESTMENT_DISCLOSURE.version } };
}

// ---- Projects ----

export const PROJECT_TYPES = ["residential_development", "commercial_development", "land_subdivision", "renovation", "mixed_use", "other"] as const;
export const PROJECT_STAGES = ["concept", "planning", "approved", "construction", "completed"] as const;
export const VISIBILITY = ["wholesale_only", "all_verified"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];
export type ProjectStage = (typeof PROJECT_STAGES)[number];
export type ProjectVisibility = (typeof VISIBILITY)[number];
export type ProjectStatus = "pending_review" | "approved" | "changes_requested" | "rejected";

export interface ProjectFields {
  title: string;
  location: string;
  jurisdiction: Jurisdiction;
  projectType: ProjectType;
  summary: string;
  stage: ProjectStage;
  /** Indicative only, AUD cents. Nothing is collected. */
  fundingTargetCents: number;
  minimumTicketCents: number;
  timeline: string;
  risks: string;
  structureDescription: string;
  visibleTo: ProjectVisibility;
  issuerName: string;
  issuerLicenceBasis: string;
  issuerStatement: string;
  issuerAuthorisedConfirmed: true;
}

export interface InvestmentProject extends ProjectFields {
  id: string;
  ownerUserId: string;
  status: ProjectStatus;
  /** Goes up on every owner edit, so a staff decision is tied to the exact text it reviewed. */
  version: number;
  /** Posting model and fee terms in force when the project was first posted. Never changed by later settings or edits. */
  terms: PostingTerms;
  reviewReason?: string;
  createdAt: string;
  updatedAt: string;
}

const LIMITS = {
  title: [3, 120], location: [2, 120], summary: [20, 4000], timeline: [2, 2000], risks: [20, 4000],
  structureDescription: [10, 4000], issuerName: [2, 200], issuerLicenceBasis: [2, 500], issuerStatement: [0, 2000]
} as const satisfies Record<string, readonly [number, number]>;

export const PROJECT_FIELDS = [
  "title", "location", "jurisdiction", "projectType", "summary", "stage", "fundingTargetCents", "minimumTicketCents", "timeline",
  "risks", "structureDescription", "visibleTo", "issuerName", "issuerLicenceBasis", "issuerStatement", "issuerAuthorisedConfirmed"
] as const;

/** Largest indicative amount accepted: $10 billion. */
export const MAX_CENTS = 1_000_000_000_000;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MARKUP = /<\s*[a-z!/?]|javascript:/i;

/** Plain text only: no control characters, no HTML. Pages render text escaped anyway; this keeps markup out of the record. */
export function cleanText(raw: unknown, min: number, max: number): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return min === 0 && raw === undefined ? { ok: true, value: "" } : { ok: false, error: "Must be text." };
  const v = raw.trim();
  if (v.length < min || v.length > max) return { ok: false, error: min === 0 ? `Up to ${max} characters.` : `Between ${min} and ${max} characters.` };
  if (CONTROL.test(v)) return { ok: false, error: "Remove special characters." };
  if (MARKUP.test(v)) return { ok: false, error: "Plain text only: remove HTML or script." };
  return { ok: true, value: v };
}

export const isCents = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 100 && v <= MAX_CENTS;

/** Every field is required (issuerStatement may be empty). Unknown fields are refused, so no payment or commitment field can be smuggled in. */
export function validateProject(raw: unknown): { ok: true; value: ProjectFields } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: { body: "Send the project as a JSON object." } };
  const b = raw as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!(PROJECT_FIELDS as readonly string[]).includes(k)) errors[k.slice(0, 40)] = "Unknown field.";
  const out: Record<string, unknown> = {};
  for (const [k, [min, max]] of Object.entries(LIMITS)) {
    const r = cleanText(b[k], min, max);
    if (r.ok) out[k] = r.value; else errors[k] = r.error;
  }
  const pick = <T extends string>(k: string, allowed: readonly T[], msg: string) => {
    const v = b[k];
    if (typeof v === "string" && (allowed as readonly string[]).includes(v)) out[k] = v; else errors[k] = msg;
  };
  if (typeof b["jurisdiction"] === "string" && isJurisdiction(b["jurisdiction"])) out["jurisdiction"] = b["jurisdiction"];
  else errors["jurisdiction"] = "Choose a state or territory.";
  pick("projectType", PROJECT_TYPES, "Choose a project type.");
  pick("stage", PROJECT_STAGES, "Choose a stage.");
  if (b["visibleTo"] === undefined) out["visibleTo"] = "wholesale_only";
  else pick("visibleTo", VISIBILITY, "Choose who may see the project.");
  for (const k of ["fundingTargetCents", "minimumTicketCents"] as const) {
    if (isCents(b[k])) out[k] = b[k]; else errors[k] = "Enter a whole amount of at least $1 and at most $10 billion.";
  }
  if (isCents(b["fundingTargetCents"]) && isCents(b["minimumTicketCents"]) && b["minimumTicketCents"] > b["fundingTargetCents"]) {
    errors["minimumTicketCents"] = "The minimum cannot be more than the target.";
  }
  if (b["issuerAuthorisedConfirmed"] === true) out["issuerAuthorisedConfirmed"] = true;
  else errors["issuerAuthorisedConfirmed"] = "Confirm you are authorised to make this offer and to rely on the licence or exemption named.";
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value: out as unknown as ProjectFields };
}

export type ReviewOutcome = "approve" | "reject" | "request_changes";
export const REVIEW_OUTCOMES: readonly ReviewOutcome[] = ["approve", "reject", "request_changes"];
const OUTCOME_STATUS: Record<ReviewOutcome, ProjectStatus> = { approve: "approved", reject: "rejected", request_changes: "changes_requested" };

/** Staff decision on a project waiting for review. Needs investment.review, a reason, and a reviewer who is not the owner. */
export function reviewProject(p: InvestmentProject, reviewer: StaffActor, outcome: ReviewOutcome, reason: string): { ok: true; status: ProjectStatus } | { ok: false; error: string } {
  if (!staffCan(reviewer, "investment.review")) return { ok: false, error: "Not allowed." };
  if (reviewer.id === p.ownerUserId) return { ok: false, error: "You cannot review your own project." };
  if (p.status !== "pending_review") return { ok: false, error: "This project is not waiting for review." };
  if (!REVIEW_OUTCOMES.includes(outcome)) return { ok: false, error: "Choose approve, reject or request changes." };
  if (reason.trim().length < 10) return { ok: false, error: "A reason of at least 10 characters is required." };
  return { ok: true, status: OUTCOME_STATUS[outcome] };
}

/** Owners may edit while the project is pending, approved or sent back. Any edit returns it to review. Rejected is final. */
export const ownerMayEdit = (p: InvestmentProject): boolean => p.status !== "rejected";

// ---- Investors ----

export const INVESTOR_CATEGORIES = ["wholesale", "sophisticated", "retail"] as const;
export type InvestorCategory = (typeof INVESTOR_CATEGORIES)[number];

export const ACKNOWLEDGEMENTS = ["notAdvice", "notAnOffer", "noFundsHeld", "offPlatformContracts"] as const;
export type Acknowledgement = (typeof ACKNOWLEDGEMENTS)[number];
export const ACK_TEXT: Record<Acknowledgement, string> = {
  notAdvice: "I understand nothing here is financial, legal or tax advice.",
  notAnOffer: "I understand projects are not an offer of securities and are indicative only.",
  noFundsHeld: "I understand the platform does not hold funds or accept investments.",
  offPlatformContracts: "I understand any agreement is made off-platform between the parties through their own solicitors."
};

export interface InvestorDeclaration { userId: string; category: InvestorCategory; disclosureVersion: string; declaredAt: string }

/** A self-declaration. Wholesale and sophisticated are the investor's own statement; counsel decides what evidence is later needed. */
export function validateDeclaration(raw: unknown): { ok: true; category: InvestorCategory } | { ok: false; error: string } {
  const b = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!b || typeof b["category"] !== "string" || !(INVESTOR_CATEGORIES as readonly string[]).includes(b["category"])) {
    return { ok: false, error: "Choose wholesale, sophisticated or retail." };
  }
  const acks = b["acknowledgements"];
  if (acks === null || typeof acks !== "object" || ACKNOWLEDGEMENTS.some(a => (acks as Record<string, unknown>)[a] !== true)) {
    return { ok: false, error: "Tick every acknowledgement." };
  }
  if (b["disclosureVersion"] !== INVESTMENT_DISCLOSURE.version) return { ok: false, error: "The risk warning changed. Reload and read it again." };
  return { ok: true, category: b["category"] as InvestorCategory };
}

export type InvestorStep = VerificationStep | "declare";
/** Next step before browsing: email, mobile and ID like a buyer, then a declaration against the current risk warning. null = ready. */
export function investorStep(v: BuyerVerification, d: InvestorDeclaration | undefined): InvestorStep | null {
  const s = nextVerificationStep(v);
  if (s) return s;
  if (!d || d.disclosureVersion !== INVESTMENT_DISCLOSURE.version) return "declare";
  return null;
}
export const investorReady = (v: BuyerVerification, d: InvestorDeclaration | undefined): boolean => canContactSeller(v) && investorStep(v, d) === null;

/** Retail investors see only projects open to all verified investors. Default visibility is wholesale only. */
export function categoryMaySee(category: InvestorCategory, visibleTo: ProjectVisibility): boolean {
  return visibleTo === "all_verified" || category === "wholesale" || category === "sophisticated";
}

// ---- Browse filters ----

export interface ProjectFilter { q?: string; jurisdiction?: string; projectType?: string; stage?: string; maxMinimumCents?: number }
interface Filterable { title: string; location: string; jurisdiction: string; projectType: string; summary: string; stage: string; minimumTicketCents: number; issuerName: string }

/** Narrows the projects an investor may already see. Every word of q must appear in the title, location, summary or issuer. */
export function filterProjects<T extends Filterable>(items: readonly T[], f: ProjectFilter): T[] {
  const words = (f.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(p => {
    if (f.jurisdiction && p.jurisdiction !== f.jurisdiction) return false;
    if (f.projectType && p.projectType !== f.projectType) return false;
    if (f.stage && p.stage !== f.stage) return false;
    if (f.maxMinimumCents !== undefined && p.minimumTicketCents > f.maxMinimumCents) return false;
    const text = `${p.title} ${p.location} ${p.summary} ${p.issuerName}`.toLowerCase();
    return words.every(w => text.includes(w));
  });
}

// ---- Interest ----

export interface InterestInput { message: string; amountMinCents: number; amountMaxCents: number }

/** Non-binding: a message and an indicative range. Not a commitment, application or allocation. */
export function validateInterest(raw: unknown): { ok: true; value: InterestInput } | { ok: false; error: string } {
  const b = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!b) return { ok: false, error: "Send a message and an indicative range." };
  const extra = Object.keys(b).filter(k => !["message", "amountMinCents", "amountMaxCents"].includes(k));
  if (extra.length > 0) return { ok: false, error: "Unknown field." };
  const m = cleanText(b["message"], 1, 4000);
  if (!m.ok) return { ok: false, error: `Message: ${m.error}` };
  const { amountMinCents: lo, amountMaxCents: hi } = b;
  if (!isCents(lo) || !isCents(hi) || lo > hi) return { ok: false, error: "Enter an indicative range: a lower and a higher whole-dollar amount." };
  return { ok: true, value: { message: m.value, amountMinCents: lo, amountMaxCents: hi } };
}
