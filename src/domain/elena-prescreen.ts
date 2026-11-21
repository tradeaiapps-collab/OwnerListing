import { validateAbn } from "./abn";
import { scanContent } from "./content-filter";
import { daysBetween } from "./contractor-trust";

/**
 * Elena pre-screens the staff work queues. Pure rules: nothing here calls a model or an outside service, so no personal data leaves the
 * server, and every recommendation names the rule and the text or field it rests on. Elena only RECOMMENDS. Staff make every decision
 * through the existing queue routes, and a bulk confirm is just staff pressing the existing decision for many high-confidence items.
 */

export const PRESCREEN_QUEUES = ["moderation", "verification", "complaint"] as const;
export type PrescreenQueue = (typeof PRESCREEN_QUEUES)[number];
export const isPrescreenQueue = (v: unknown): v is PrescreenQueue => typeof v === "string" && (PRESCREEN_QUEUES as readonly string[]).includes(v);

export type Confidence = "high" | "medium" | "low";
/** What Elena suggests. "review" means she cannot tell and staff should look at it themselves. */
export type PrescreenAction = "approve" | "hide" | "suspend" | "needs_info" | "uphold" | "dismiss" | "uphold_and_suspend" | "review";

export interface Recommendation {
  action: PrescreenAction;
  confidence: Confidence;
  /** Stable id of the rule that fired, for accuracy review. */
  rule: string;
  /** One or two sentences for staff, citing the matched text or field. */
  reason: string;
  /** Verification only: a drafted message to the contractor (staff can edit it, then reject with it as the note). */
  draft?: string;
  /** Complaints only: the facts Elena put together and the next steps she suggests. */
  summary?: string[];
  nextSteps?: string[];
  /** Moderation only: other open items that look like the same thing. */
  duplicateOf?: string;
  groupSize?: number;
}

/** A drafted request becomes the contractor-facing review note, which holds 500 characters. Whole lines are dropped from the end rather than cut mid-sentence. */
export function fitDraft(head: string, asks: readonly string[], foot: string, max = 500): string {
  const build = (n: number) => [head, ...asks.slice(0, n).map(a => `- ${a}`), ...(n < asks.length ? ["- And a few more details; we will list them next."] : []), foot].join("\n");
  for (let n = asks.length; n > 0; n--) { const t = build(n); if (t.length <= max) return t; }
  return build(1).slice(0, max);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------- Moderation ----------
export interface ModerationFacts {
  id: string; subjectType: "listing" | "message" | "profile"; source: string; reason: string; detail: string | null; severity: "low" | "medium" | "high";
  /** How many items about the same account staff rejected in the last 90 days. */
  ownerRecentRejections: number;
  hasOwner: boolean;
}

const normaliseText = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^a-z0-9]+/g, " ").trim();
/** Two items with the same account and the same flagged text are one problem. The first (oldest) item leads the group. */
export const moderationGroupKey = (f: Pick<ModerationFacts, "subjectType" | "detail" | "reason">, ownerId: string | null): string =>
  `${ownerId ?? "-"}|${f.subjectType}|${normaliseText(f.detail ?? f.reason).slice(0, 200)}`;

export function recommendModeration(f: ModerationFacts): Recommendation {
  if (f.source !== "content_filter" || !f.detail) {
    return { action: "review", confidence: "low", rule: "mod.unknown_source", reason: `This came from "${f.source.replace(/_/g, " ")}" and carries no text Elena can check, so it needs a person.` };
  }
  const scan = scanContent(f.detail);
  const abuse = scan.hits.filter(h => h.category === "abuse");
  const blocked = abuse.filter(h => h.action === "block");
  const contact = scan.hits.filter(h => h.category === "contact_details");
  const spam = scan.hits.filter(h => h.category === "spam");
  const quote = (hits: { match: string }[]) => hits.slice(0, 3).map(h => `"${clip(h.match, 40)}"`).join(", ");

  if (blocked.length > 0) {
    if (f.ownerRecentRejections >= 3 && f.hasOwner) {
      return { action: "suspend", confidence: "medium", rule: "mod.abuse_repeat",
        reason: `The text contains ${quote(blocked)} and this account has had ${f.ownerRecentRejections} items rejected in the last 90 days. Suspending is your call.` };
    }
    return { action: "hide", confidence: f.subjectType === "message" || blocked.length > 1 ? "high" : "medium", rule: "mod.abuse_blocked",
      reason: `The text contains ${quote(blocked)}, which the abuse rule blocks outright.` };
  }
  if (contact.length > 0) {
    return { action: "hide", confidence: "medium", rule: "mod.contact_details",
      reason: `The text contains contact details or an outside link (${quote(contact)}). Check it is not a business address the page allows.` };
  }
  if (abuse.length > 0) {
    return { action: f.ownerRecentRejections === 0 ? "approve" : "review", confidence: "medium", rule: "mod.abuse_mild",
      reason: `Only mild wording matched (${quote(abuse)}), nothing that the rules block.${f.ownerRecentRejections ? ` The account has ${f.ownerRecentRejections} earlier rejection${f.ownerRecentRejections === 1 ? "" : "s"}, so please look.` : ""}` };
  }
  if (spam.length > 0) {
    return { action: "review", confidence: "low", rule: "mod.spam", reason: `Spam signal: ${quote(spam)}. Spam rules are often wrong on honest text, so Elena leaves it to you.` };
  }
  // Nothing matches any more. Only a spam-only flag is safe to clear: spam rules are noisy and a re-scan of the excerpt is a fair second look.
  // A flag raised for abuse, contact details or anything else Elena cannot re-check (a masked number, a cut-short excerpt) stays with a person.
  if (/^flagged: spam$/i.test(f.reason.trim()) && f.ownerRecentRejections === 0 && f.severity !== "high") {
    return { action: "approve", confidence: "high", rule: "mod.no_match",
      reason: "The flag was for spam only. The saved text no longer matches any spam, abuse or contact rule, and this account has no recent rejections." };
  }
  return { action: "review", confidence: "low", rule: "mod.no_match_history", reason: "The excerpt matches no current rule, but the flag was for something Elena cannot re-check, or the item was high severity, or the account has earlier rejections." };
}

/** Marks duplicates inside one page of open items. The oldest item of each group leads; the others point at it. */
export function groupModeration<T extends { id: string; createdAt: string; groupKey: string }>(items: readonly T[]): Map<string, { leadId: string; size: number }> {
  const byKey = new Map<string, T[]>();
  for (const i of items) byKey.set(i.groupKey, [...(byKey.get(i.groupKey) ?? []), i]);
  const out = new Map<string, { leadId: string; size: number }>();
  for (const g of byKey.values()) {
    const lead = [...g].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]!;
    for (const i of g) out.set(i.id, { leadId: lead.id, size: g.length });
  }
  return out;
}

// ---------- Contractor verification ----------
export interface VerificationFacts {
  businessName: string; accountName: string; abn: string;
  licenceNumber: string | null; licenceAuthority: string | null; licenceExpiry: string | null;
  insurer: string; policyNumber: string; insuranceExpiry: string;
  /** Trades the contractor offers (contractor_profile.kind). Inspectors and pest controllers must hold a licence. */
  trades: readonly string[];
  /** Another contractor account already uses this ABN. */
  abnUsedByOther: boolean;
}
const LICENSED_TRADES = ["inspector", "pest_control"];
const SOON_DAYS = 45;
const STOP = new Set(["pty", "ltd", "limited", "the", "and", "co", "company", "services", "service", "group", "trading", "as", "of", "family", "trust"]);
const tokens = (s: string) => normaliseText(s).split(" ").filter(t => t.length > 1 && !STOP.has(t));

/** True when the business name and the account name share no meaningful word. A trading name can legitimately differ, so this only asks. */
export function namesDisagree(business: string, account: string): boolean {
  const a = new Set(tokens(business));
  const b = tokens(account);
  if (a.size === 0 || b.length === 0) return false;
  return !b.some(t => a.has(t));
}

const placeholder = (s: string) => {
  const t = s.replace(/[\s-]/g, "").toLowerCase();
  return t.length < 4 || /^(.)\1+$/.test(t) || /^(0123|1234|12345|abc|test|na|none|tbc|xxx)/.test(t);
};

export function recommendVerification(f: VerificationFacts, today: string): Recommendation {
  const problems: { rule: string; text: string; ask: string }[] = [];
  const abn = validateAbn(f.abn);
  if (!abn.ok) problems.push({ rule: "ver.abn_invalid", text: `The ABN ${f.abn} fails the ABN check (${abn.error}).`, ask: "Please send your correct 11-digit ABN." });
  if (f.abnUsedByOther) problems.push({ rule: "ver.abn_duplicate", text: "Another contractor account already uses this ABN.", ask: "Please tell us how this ABN relates to your account (for example, which business you act for)." });
  const insDays = daysBetween(today, f.insuranceExpiry);
  if (insDays < 0) problems.push({ rule: "ver.insurance_expired", text: `Insurance expired on ${f.insuranceExpiry}.`, ask: "Your insurance has expired. Please submit your current certificate of currency." });
  else if (insDays <= SOON_DAYS) problems.push({ rule: "ver.insurance_soon", text: `Insurance expires on ${f.insuranceExpiry}, in ${insDays} day${insDays === 1 ? "" : "s"}.`, ask: `Your insurance expires on ${f.insuranceExpiry}. Please submit the renewed certificate of currency so your badge does not lapse.` });
  if (placeholder(f.policyNumber)) problems.push({ rule: "ver.policy_placeholder", text: `The policy number "${clip(f.policyNumber, 20)}" looks like a placeholder.`, ask: "Please send the policy number exactly as shown on your certificate of currency." });
  const needsLicence = f.trades.some(t => LICENSED_TRADES.includes(t));
  if (needsLicence && !f.licenceNumber) problems.push({ rule: "ver.licence_missing", text: `Trade (${f.trades.filter(t => LICENSED_TRADES.includes(t)).join(", ").replace(/_/g, " ")}) needs a licence and none was given.`, ask: "Your trade needs a licence. Please send your licence number, the issuing authority and its expiry date." });
  if (f.licenceNumber) {
    if (!f.licenceExpiry) problems.push({ rule: "ver.licence_no_expiry", text: "A licence number was given without an expiry date.", ask: "Please add the licence expiry date." });
    else {
      const d = daysBetween(today, f.licenceExpiry);
      if (d < 0) problems.push({ rule: "ver.licence_expired", text: `Licence expired on ${f.licenceExpiry}.`, ask: "Your licence has expired. Please send the renewed licence details." });
      else if (d <= SOON_DAYS) problems.push({ rule: "ver.licence_soon", text: `Licence expires on ${f.licenceExpiry}, in ${d} day${d === 1 ? "" : "s"}.`, ask: `Your licence expires on ${f.licenceExpiry}. Please send the renewal details so your badge does not lapse.` });
    }
    if (placeholder(f.licenceNumber)) problems.push({ rule: "ver.licence_placeholder", text: `The licence number "${clip(f.licenceNumber, 20)}" looks like a placeholder.`, ask: "Please send the licence number exactly as the issuing authority shows it." });
  }
  const mismatch = namesDisagree(f.businessName, f.accountName);

  if (problems.length > 0) {
    const first = problems[0]!;
    const hard = problems.some(p => /expired|invalid|missing|placeholder/.test(p.rule));
    return {
      action: "needs_info", confidence: hard ? "high" : "medium", rule: first.rule,
      reason: problems.map(p => p.text).join(" ") + (mismatch ? ` The business name "${clip(f.businessName, 40)}" shares no word with the account name.` : ""),
      draft: fitDraft("Thanks for submitting your details. Before we can verify you we need a little more:",
        [...problems.map(p => p.ask), ...(mismatch ? ["Your business name and the name on your account look different. Please tell us how they are related (for example, a trading name)."] : [])],
        "Update your details in your contractor profile and we will look again straight away.")
    };
  }
  if (mismatch) {
    return {
      action: "needs_info", confidence: "medium", rule: "ver.name_mismatch",
      reason: `The business name "${clip(f.businessName, 40)}" shares no word with the account name "${clip(f.accountName, 40)}". It may be a trading name, so please compare it with the ABN register.`,
      draft: "Thanks for submitting your details. Your business name and the name on your account look different. Please tell us how they are related (for example, a trading name), then we can verify you."
    };
  }
  const licDays = f.licenceExpiry ? daysBetween(today, f.licenceExpiry) : null;
  return {
    action: "approve", confidence: insDays >= 180 && (licDays === null || licDays >= 180) ? "high" : "medium", rule: "ver.complete",
    reason: `ABN passes the check and is not used elsewhere, insurance runs to ${f.insuranceExpiry}${f.licenceNumber ? `, licence runs to ${f.licenceExpiry}` : ""}, and the names agree. Elena cannot check the ABN register or the certificate itself, so compare them before you verify.`
  };
}

// ---------- Complaints ----------
export interface ComplaintFacts {
  kind: string; detail: string; filedAt: string;
  job: { kind: string; status: string; createdAt: string; scheduledTime: string | null; completedAt: string | null; contractorDoneAt: string | null };
  contractor: { jobsTotal: number; jobsCompleted: number; averageRating: number | null; ratingCount: number; suspended: boolean; upheldBefore: number; dismissedBefore: number; openOthers: number };
  /** Complaints this same reporter filed against this same contractor before this one. */
  reporterEarlier: { total: number; dismissed: number };
}
const KIND_TEXT: Record<string, string> = { no_show: "did not turn up", poor_work: "poor work", late: "was late", conduct: "conduct", other: "something else" };

export function recommendComplaint(c: ComplaintFacts): Recommendation {
  const k = c.contractor;
  const summary = [
    `Complaint: ${KIND_TEXT[c.kind] ?? c.kind}, about a ${c.job.kind.replace(/_/g, " ")} job (${c.job.status.replace(/_/g, " ")}).`,
    c.job.scheduledTime ? `The job was scheduled for ${c.job.scheduledTime.slice(0, 16).replace("T", " ")} UTC.` : "No time was ever scheduled for the job.",
    c.job.completedAt ? `The job was marked completed on ${c.job.completedAt.slice(0, 10)}.` : c.job.contractorDoneAt ? "The contractor marked it done; the owner has not confirmed." : "The job is not marked done.",
    `Contractor history: ${k.jobsTotal} job${k.jobsTotal === 1 ? "" : "s"} (${k.jobsCompleted} completed), ${k.averageRating === null ? "no ratings yet" : `rated ${k.averageRating.toFixed(1)} from ${k.ratingCount}`}.`,
    `Other complaints about them: ${k.upheldBefore} upheld, ${k.dismissedBefore} dismissed, ${k.openOthers} still open.${k.suspended ? " They are already suspended." : ""}`,
    ...(c.reporterEarlier.total > 0 ? [`This owner filed ${c.reporterEarlier.total} earlier complaint${c.reporterEarlier.total === 1 ? "" : "s"} about the same contractor (${c.reporterEarlier.dismissed} dismissed).`] : [])
  ];
  const steps: string[] = [];
  const done = (extra: Partial<Recommendation> & Pick<Recommendation, "action" | "confidence" | "rule" | "reason">): Recommendation => ({ ...extra, summary, nextSteps: steps });

  const scheduledPast = c.job.scheduledTime !== null && new Date(c.job.scheduledTime).getTime() < new Date(c.filedAt).getTime();
  if (c.reporterEarlier.total >= 2 && c.reporterEarlier.dismissed === c.reporterEarlier.total) {
    steps.push("Read the owner's earlier complaints before deciding.", "If the pattern holds, dismiss with a note that explains why.");
    return done({ action: "dismiss", confidence: "medium", rule: "cmp.repeat_dismissed", reason: `The same owner has filed ${c.reporterEarlier.total} earlier complaints about this contractor and staff dismissed all of them.` });
  }
  if (c.kind === "conduct") {
    steps.push("Read the owner's account carefully; conduct complaints can involve safety.", "Contact the contractor for their side before suspending unless there is a safety risk.");
    if (k.upheldBefore >= 1 && !k.suspended) return done({ action: "uphold_and_suspend", confidence: "medium", rule: "cmp.conduct_repeat", reason: `A conduct complaint, and ${k.upheldBefore} earlier complaint${k.upheldBefore === 1 ? " was" : "s were"} upheld. Elena never suspends anyone herself.` });
    return done({ action: "review", confidence: "low", rule: "cmp.conduct", reason: "Conduct complaints depend on what was said or done, which Elena cannot judge." });
  }
  if (c.kind === "no_show") {
    if (scheduledPast && !c.job.contractorDoneAt && !c.job.completedAt) {
      steps.push("Ask the contractor why they did not attend.", "If they have no reason, uphold; a second upheld no-show suggests suspension.");
      return done({ action: k.upheldBefore >= 2 && !k.suspended ? "uphold_and_suspend" : "uphold", confidence: "medium", rule: "cmp.no_show_confirmed",
        reason: "The scheduled time had passed when the complaint was filed and the job was never marked done, which fits a no-show." });
    }
    steps.push("Check the job chat for a rescheduled time.", "Ask both sides for their account.");
    return done({ action: "review", confidence: "low", rule: "cmp.no_show_unclear", reason: c.job.contractorDoneAt || c.job.completedAt ? "The job was marked done, which contradicts a no-show." : "There was no scheduled time, so Elena cannot tell whether they missed it." });
  }
  if (c.kind === "poor_work" && k.upheldBefore >= 2 && !k.suspended) {
    steps.push("Look at the job's photos and files.", "Consider asking the contractor to redo the work or refund before suspending.");
    return done({ action: "uphold", confidence: "medium", rule: "cmp.poor_work_pattern", reason: `${k.upheldBefore} earlier complaints about this contractor were upheld, so this looks like a pattern.` });
  }
  steps.push("Read the owner's account and the job chat.", "Ask the contractor for their side if the facts are disputed.");
  return done({ action: "review", confidence: "low", rule: "cmp.subjective", reason: "This kind of complaint turns on judgement about the work or timing, so Elena leaves it to staff." });
}

// ---------- Outcome logging ----------
export type StaffAction = "approve" | "hide" | "suspend" | "escalate" | "verify" | "needs_info" | "dismiss" | "uphold" | "uphold_and_suspend";

/** Did staff do what Elena suggested? "review" is never agreed with: Elena made no call, so it counts as neutral. */
export function agreed(rec: PrescreenAction, staff: StaffAction): boolean | null {
  if (rec === "review") return null;
  const normal = staff === "verify" ? "approve" : staff;
  return rec === normal;
}

/** Map a moderation decision to the vocabulary above (a reject that also suspends the account counts as "suspend"; suspending only the listing is a "hide"). */
export const moderationStaffAction = (decision: "approve" | "reject" | "escalate", suspend: "none" | "listing" | "account"): StaffAction =>
  decision === "approve" ? "approve" : decision === "escalate" ? "escalate" : suspend === "account" ? "suspend" : "hide";

/** Bulk confirm is allowed only for an approve at high confidence. */
export const bulkEligible = (r: Recommendation): boolean => r.action === "approve" && r.confidence === "high";
export const BULK_MAX_IDS = 25;

/**
 * What staff must confirm for EACH contractor before a bulk verify applies. Elena's text checks cannot see the ABN register or the certificates,
 * so bulk verify needs a per-item attestation that a person looked at them. A licence confirmation is needed only when a licence was given.
 */
export interface VerifyEvidence { abnRegister: true; insuranceCertificate: true; licenceRegister?: true }
export function verifyEvidenceProblem(ev: unknown, hasLicence: boolean): string | null {
  if (typeof ev !== "object" || ev === null || Array.isArray(ev)) return "Confirm for this contractor that you checked the ABN register, the insurance certificate and the licence.";
  const e = ev as Record<string, unknown>;
  if (e["abnRegister"] !== true) return "Confirm you checked this ABN on the ABN register.";
  if (e["insuranceCertificate"] !== true) return "Confirm you checked the insurance certificate of currency.";
  if (hasLicence && e["licenceRegister"] !== true) return "Confirm you checked the licence with the issuing authority.";
  return null;
}
/** Plain wording stored in the decision note so the audit trail shows what the person attested. */
export const evidenceNote = (hasLicence: boolean): string => `Staff confirmed: ABN register, insurance certificate${hasLicence ? ", licence with the issuing authority" : ""}.`;
export const BULK_MAX_PER_HOUR = 100;

/**
 * What is stored in the permanent recommendation log: the rule in general words only. The live reason quotes matched text, names and policy
 * numbers; those must never reach a table that cannot be deleted (account deletion has to be honoured).
 */
export const RULE_TEXT: Record<string, string> = {
  "mod.unknown_source": "Source gives no text Elena can check.", "mod.abuse_repeat": "Blocked abusive wording from an account with repeated rejections.",
  "mod.abuse_blocked": "Blocked abusive wording matched.", "mod.contact_details": "Contact details or an outside link matched.",
  "mod.abuse_mild": "Only mild wording matched.", "mod.spam": "A spam signal matched.", "mod.no_match": "Spam-only flag that no longer matches any rule.",
  "mod.no_match_history": "No rule matches now, but the flag cannot be re-checked or the account has history.",
  "ver.abn_invalid": "ABN fails the checksum.", "ver.abn_duplicate": "ABN is used by another account.", "ver.insurance_expired": "Insurance has expired.",
  "ver.insurance_soon": "Insurance expires soon.", "ver.policy_placeholder": "Policy number looks like a placeholder.", "ver.licence_missing": "Licence missing for a licensed trade.",
  "ver.licence_no_expiry": "Licence given without an expiry.", "ver.licence_expired": "Licence has expired.", "ver.licence_soon": "Licence expires soon.",
  "ver.licence_placeholder": "Licence number looks like a placeholder.", "ver.name_mismatch": "Business name and account name share no word.",
  "ver.complete": "All text checks pass; the register and certificate were not checked.",
  "cmp.repeat_dismissed": "Same owner's earlier complaints about this contractor were all dismissed.", "cmp.conduct_repeat": "Conduct complaint and an earlier upheld complaint.",
  "cmp.conduct": "Conduct complaint needs judgement.", "cmp.no_show_confirmed": "Scheduled time passed and the job was never marked done.",
  "cmp.no_show_unclear": "No-show cannot be confirmed from the job record.", "cmp.poor_work_pattern": "Several earlier complaints were upheld.",
  "cmp.subjective": "Complaint turns on judgement."
};
export const ruleText = (rule: string): string => RULE_TEXT[rule] ?? "Rule fired.";
