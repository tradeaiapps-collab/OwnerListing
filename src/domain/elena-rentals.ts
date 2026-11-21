import { scanContent } from "./content-filter";
import { CATEGORY_LABELS, scanForDiscrimination, type DiscriminationCategory } from "./discrimination-filter";
import type { EmergencyTrade } from "./emergency";
import { checkOutbound, rateLimited } from "./elena-jobs";
import type { Failure, Result } from "./listing-service";

/**
 * Elena for rentals: screening applications, offering viewings and triaging tenant repair requests. Pure functions; the server layer stores
 * the state and sends the messages.
 *
 * Rules that never bend:
 *  - Elena summarises and flags. She never declines, approves or ranks anyone out: the owner decides every application.
 *  - Only four things are weighed: rent against stated income, rental history, references and the move-in date. Nothing else is read, so
 *    age, family, religion, race, disability, occupation and where someone is from can neither be used nor inferred. The applicant's free-text
 *    note is never part of the summary, and is withheld from the owner when it names such an attribute.
 *  - No rental history is shown as "not provided", never as a failure (first-time renters are not marked down).
 *  - Every message is fixed wording filled from stored fields, content-checked, rate-limited per person, logged and never mentions money.
 *  - A repair never commits money: the job offer carries no price. Contractors are paid directly.
 */

const bad = (message: string): Failure => ({ ok: false, code: "invalid", message });
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export const RENTAL_LIMITS = {
  applicationsPerDay: 5,
  maxSlots: 40,
  maxCapacity: 6,
  slotHorizonDays: 60,
  minLeadMinutes: 60,
  offerCount: 3,
  infoRequestsMax: 2,
  infoRequestGapMs: 48 * 3600_000,
  repairsPerHour: 3,
  repairsPerDay: 8,
  maxPhotos: 3,
  maxPhotoBytes: 2 * 1024 * 1024,
  repairChaseMax: 3
} as const;

// ---- The owner's criteria -------------------------------------------------------------------------------------------------------

export interface Criteria { maxRentPct: number; minHistoryMonths: number; minReferences: number; moveInFrom?: string; moveInTo?: string }
export const DEFAULT_CRITERIA: Criteria = { maxRentPct: 35, minHistoryMonths: 0, minReferences: 0 };

const int = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : typeof v === "string" && /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max ? Number(v) : undefined;

/** A YYYY-MM-DD calendar date, or undefined when it is not a real date. */
export function parseDate(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = DATE.exec(v);
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v ? v : undefined;
}

export function parseCriteria(input: unknown): Result<Criteria> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return bad("Send a JSON object.");
  const o = input as Record<string, unknown>;
  const maxRentPct = int(o["maxRentPct"], 10, 100);
  const minHistoryMonths = int(o["minHistoryMonths"], 0, 120);
  const minReferences = int(o["minReferences"], 0, 5);
  if (maxRentPct === undefined) return bad("Rent as a share of income must be between 10 and 100 per cent.");
  if (minHistoryMonths === undefined) return bad("Rental history must be 0 to 120 months.");
  if (minReferences === undefined) return bad("References must be 0 to 5.");
  const from = o["moveInFrom"] === undefined || o["moveInFrom"] === "" || o["moveInFrom"] === null ? undefined : parseDate(o["moveInFrom"]);
  const to = o["moveInTo"] === undefined || o["moveInTo"] === "" || o["moveInTo"] === null ? undefined : parseDate(o["moveInTo"]);
  if (o["moveInFrom"] && from === undefined) return bad("Enter the earliest move-in date as a real date.");
  if (o["moveInTo"] && to === undefined) return bad("Enter the latest move-in date as a real date.");
  if (from && to && to < from) return bad("The latest move-in date must not be before the earliest.");
  return { ok: true, value: { maxRentPct, minHistoryMonths, minReferences, ...(from ? { moveInFrom: from } : {}), ...(to ? { moveInTo: to } : {}) } };
}

// ---- An application -------------------------------------------------------------------------------------------------------------

export interface ApplicationFields { weeklyIncomeCents?: number; rentalHistoryMonths?: number; referencesCount?: number; moveInDate?: string }
export interface ParsedApplication extends ApplicationFields { note?: string; noteWithheld: boolean; noteReason?: string }

/**
 * Words an applicant might use about themselves that name a protected attribute. The owner's wording filter looks for what a landlord writes, so
 * this list looks for what a person says about themselves. A match only withholds the note from the owner; it never changes the summary or the rank.
 */
const SELF_DESCRIBED: [RegExp, DiscriminationCategory][] = [
  [/\b(?:famil(?:y|ies)|child(?:ren)?|kids?|baby|babies|toddler|pregnan\w*|expecting|son|daughter|single (?:mum|mom|mother|dad|father|parent)|solo parent)\b/i, "familial_status"],
  [/\b(?:young|old(?:er)?|elderly|senior|retire[de]?|pensioner|student|teen\w*|\d{2}\s*(?:years?|yrs?)(?:\s*old)?|aged?\s*\d{2}|in my (?:20|30|40|50|60|70)s)\b/i, "age"],
  [/\b(?:muslim|christian|catholic|jewish|hindu|buddhist|sikh|atheist|church|mosque|temple|religio\w*|faith|pray\w*)\b/i, "religion"],
  [/\b(?:aboriginal|indigenous|torres strait|asian|african|european|arab|migrant|immigrant|refugee|visa|citizen\w*|ethnic\w*|race|racial|nationality|born in|originally from)\b/i, "race"],
  [/\b(?:married|marriage|husband|wife|spouse|partner|fianc\w+|divorced|separated|widow\w*|single|de ?facto|girlfriend|boyfriend)\b/i, "relationship_status"],
  [/\b(?:disab\w*|wheelchair|ndis|autis\w*|adhd|mental health|depress\w*|anxiety|illness|chronic|carer|hearing|vision impair\w*|blind|deaf)\b/i, "disability"],
  [/\b(?:gay|lesbian|bisexual|trans(?:gender)?|queer|lgbt\w*|non-?binary|pronouns?|male|female|man|woman|he\/him|she\/her)\b/i, "sexuality_gender"],
  [/\b(?:centrelink|jobseeker|disability support|pension|benefits?|welfare|government payment|income support|unemployed)\b/i, "income_source"]
];

/**
 * An application is the four facts above plus an optional note. Every field may be left out: Elena asks for what is missing.
 * Income is the household's weekly income before tax, in dollars, as the applicant states it; evidence is the owner's to ask for.
 */
export function parseApplication(input: unknown, todayIso: string): Result<ParsedApplication> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return bad("Send a JSON object.");
  const o = input as Record<string, unknown>;
  const out: ParsedApplication = { noteWithheld: false };
  if (o["weeklyIncome"] !== undefined && o["weeklyIncome"] !== "" && o["weeklyIncome"] !== null) {
    const n = typeof o["weeklyIncome"] === "number" ? o["weeklyIncome"] : Number(String(o["weeklyIncome"]).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return bad("Enter weekly household income in dollars before tax, for example 1800.");
    out.weeklyIncomeCents = Math.round(n * 100);
  }
  if (o["rentalHistoryMonths"] !== undefined && o["rentalHistoryMonths"] !== "" && o["rentalHistoryMonths"] !== null) {
    const n = int(o["rentalHistoryMonths"], 0, 600);
    if (n === undefined) return bad("Rental history is a number of months, 0 or more.");
    out.rentalHistoryMonths = n;
  }
  if (o["referencesCount"] !== undefined && o["referencesCount"] !== "" && o["referencesCount"] !== null) {
    const n = int(o["referencesCount"], 0, 10);
    if (n === undefined) return bad("References is a number from 0 to 10.");
    out.referencesCount = n;
  }
  if (o["moveInDate"] !== undefined && o["moveInDate"] !== "" && o["moveInDate"] !== null) {
    const d = parseDate(o["moveInDate"]);
    if (d === undefined) return bad("Enter the move-in date as a real date.");
    const today = Date.parse(todayIso.slice(0, 10));
    if (Date.parse(d) < today - DAY_MS || Date.parse(d) > today + 366 * DAY_MS) return bad("Choose a move-in date within the next year.");
    out.moveInDate = d;
  }
  const rawNote = typeof o["note"] === "string" ? o["note"].trim() : "";
  if (rawNote.length > 500) return bad("The note must be 500 characters or fewer.");
  if (rawNote) {
    const flagged = scanForDiscrimination(rawNote).flags[0]?.category ?? SELF_DESCRIBED.find(([re]) => re.test(rawNote))?.[1];
    const contact = scanContent(rawNote);
    if (contact.action === "block") out.noteWithheld = true, out.noteReason = "it contains contact details, links or blocked words";
    else if (flagged) out.noteWithheld = true, out.noteReason = `it mentions ${CATEGORY_LABELS[flagged]}, which Elena does not use and the owner should not weigh`;
    out.note = rawNote;
  }
  return { ok: true, value: out };
}

// ---- Screening ------------------------------------------------------------------------------------------------------------------

export type CriterionKey = "income" | "history" | "references" | "move_in";
export type CriterionStatus = "met" | "not_met" | "missing" | "not_asked";
export interface CriterionResult { key: CriterionKey; label: string; status: CriterionStatus; reason: string }
export interface Evaluation { criteria: CriterionResult[]; met: number; notMet: number; missing: CriterionKey[]; headline: string }

export const CRITERION_LABELS: Record<CriterionKey, string> = { income: "Rent against income", history: "Rental history", references: "References", move_in: "Move-in date" };
export const NOT_USED_NOTE =
  "Elena weighs only rent against income, rental history, references and the move-in date. She does not use or infer age, family, religion, race, disability, occupation or any other personal attribute. She never declines anyone: you decide.";

const longDate = (d: string) => new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
const months = (n: number) => `${n} month${n === 1 ? "" : "s"}`;

/** Plain-language result for each of the four criteria. A missing fact is "missing", not a failure. */
export function evaluate(a: ApplicationFields, c: Criteria, weeklyRentCents: number | undefined): Evaluation {
  const r: CriterionResult[] = [];
  // Income
  if (weeklyRentCents === undefined || weeklyRentCents <= 0) r.push({ key: "income", label: CRITERION_LABELS.income, status: "not_asked", reason: "The listing has no weekly rent yet." });
  else if (a.weeklyIncomeCents === undefined) r.push({ key: "income", label: CRITERION_LABELS.income, status: "missing", reason: "Weekly household income was not given." });
  else {
    const pct = Math.round((weeklyRentCents / a.weeklyIncomeCents) * 1000) / 10;
    r.push({ key: "income", label: CRITERION_LABELS.income, status: pct <= c.maxRentPct ? "met" : "not_met", reason: `Rent would be ${pct}% of the stated income (your limit is ${c.maxRentPct}%).` });
  }
  // History
  if (c.minHistoryMonths === 0) r.push({ key: "history", label: CRITERION_LABELS.history, status: "not_asked", reason: "You did not ask for a minimum." });
  else if (a.rentalHistoryMonths === undefined || a.rentalHistoryMonths === 0)
    r.push({ key: "history", label: CRITERION_LABELS.history, status: "missing", reason: `No rental history provided (you asked for ${months(c.minHistoryMonths)}). Elena does not count this against anyone: first-time renters are shown as not provided.` });
  else r.push({ key: "history", label: CRITERION_LABELS.history, status: a.rentalHistoryMonths >= c.minHistoryMonths ? "met" : "not_met", reason: `${months(a.rentalHistoryMonths)} of rental history (you asked for ${months(c.minHistoryMonths)}).` });
  // References
  if (c.minReferences === 0) r.push({ key: "references", label: CRITERION_LABELS.references, status: "not_asked", reason: "You did not ask for a minimum." });
  else if (a.referencesCount === undefined) r.push({ key: "references", label: CRITERION_LABELS.references, status: "missing", reason: `The number of references was not given (you asked for ${c.minReferences}).` });
  else r.push({ key: "references", label: CRITERION_LABELS.references, status: a.referencesCount >= c.minReferences ? "met" : "not_met", reason: `${a.referencesCount} reference${a.referencesCount === 1 ? "" : "s"} offered (you asked for ${c.minReferences}).` });
  // Move-in
  if (!c.moveInFrom && !c.moveInTo) r.push({ key: "move_in", label: CRITERION_LABELS.move_in, status: "not_asked", reason: "You did not set a move-in window." });
  else if (a.moveInDate === undefined) r.push({ key: "move_in", label: CRITERION_LABELS.move_in, status: "missing", reason: "A move-in date was not given." });
  else {
    const early = c.moveInFrom !== undefined && a.moveInDate < c.moveInFrom, late = c.moveInTo !== undefined && a.moveInDate > c.moveInTo;
    const window = c.moveInFrom && c.moveInTo ? `${longDate(c.moveInFrom)} to ${longDate(c.moveInTo)}` : c.moveInFrom ? `from ${longDate(c.moveInFrom)}` : `by ${longDate(c.moveInTo!)}`;
    r.push({ key: "move_in", label: CRITERION_LABELS.move_in, status: early || late ? "not_met" : "met", reason: `Wants to move in on ${longDate(a.moveInDate)} (your window is ${window}).` });
  }
  const met = r.filter(x => x.status === "met").length, notMet = r.filter(x => x.status === "not_met").length;
  const missing = r.filter(x => x.status === "missing").map(x => x.key);
  const asked = r.filter(x => x.status !== "not_asked").length;
  const headline = asked === 0 ? "You set no criteria, so there is nothing to compare yet."
    : `Meets ${met} of ${asked} criteria${notMet ? `, ${notMet} not met` : ""}${missing.length ? `, ${missing.length} not provided` : ""}.`;
  return { criteria: r, met, notMet, missing, headline };
}

export interface RankInput { id: string; createdAt: string; evaluation: Evaluation }
export interface Ranked { id: string; rank: number }
/**
 * Side-by-side order: fewest criteria not met, then most met, then fewest not provided, then the earlier application. The tie-break is
 * the order people applied, nothing about the person. A rank is a sort order for the owner's convenience, not a recommendation to refuse anyone.
 */
export function rankApplications(items: readonly RankInput[]): Ranked[] {
  return [...items]
    .sort((x, y) => x.evaluation.notMet - y.evaluation.notMet || y.evaluation.met - x.evaluation.met || x.evaluation.missing.length - y.evaluation.missing.length || x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id))
    .map((x, i) => ({ id: x.id, rank: i + 1 }));
}

export const MISSING_PROMPT: Record<CriterionKey, string> = {
  income: "your weekly household income before tax", history: "how many months of rental history you have (or leave it blank if this is your first rental)",
  references: "how many references you can offer", move_in: "the date you would like to move in"
};

// ---- Viewings -------------------------------------------------------------------------------------------------------------------

export interface SlotInput { startsAt: string; durationMin: number; capacity: number }
export function parseSlots(input: unknown, nowIso: string): Result<SlotInput[]> {
  const list = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>)["slots"] : undefined;
  if (!Array.isArray(list) || list.length === 0) return bad("Add at least one viewing time.");
  if (list.length > RENTAL_LIMITS.maxSlots) return bad(`Add up to ${RENTAL_LIMITS.maxSlots} times at once.`);
  const now = Date.parse(nowIso);
  const seen = new Set<string>();
  const out: SlotInput[] = [];
  for (const s of list) {
    if (typeof s !== "object" || s === null) return bad("Each viewing time needs a start.");
    const o = s as Record<string, unknown>;
    const t = typeof o["startsAt"] === "string" ? Date.parse(o["startsAt"]) : NaN;
    if (!Number.isFinite(t)) return bad("Give each viewing time with a time zone.");
    if (t < now + RENTAL_LIMITS.minLeadMinutes * 60_000) return bad("Viewing times must be at least an hour from now.");
    if (t > now + RENTAL_LIMITS.slotHorizonDays * DAY_MS) return bad(`Viewing times must be within ${RENTAL_LIMITS.slotHorizonDays} days.`);
    const durationMin = o["durationMin"] === undefined ? 15 : int(o["durationMin"], 10, 60);
    const capacity = o["capacity"] === undefined ? 1 : int(o["capacity"], 1, RENTAL_LIMITS.maxCapacity);
    if (durationMin === undefined) return bad("A viewing lasts 10 to 60 minutes.");
    if (capacity === undefined) return bad(`Each viewing takes 1 to ${RENTAL_LIMITS.maxCapacity} people.`);
    const startsAt = new Date(t).toISOString();
    if (seen.has(startsAt)) continue;
    seen.add(startsAt);
    out.push({ startsAt, durationMin, capacity });
  }
  return { ok: true, value: out.sort((a, b) => a.startsAt.localeCompare(b.startsAt)) };
}

export interface OfferSlot { id: string; startsAt: string; capacity: number; booked: number; status: string }
/** The next free times Elena offers an applicant: open, with room, at least an hour away. */
export function pickOffers<T extends OfferSlot>(slots: readonly T[], nowIso: string, count: number = RENTAL_LIMITS.offerCount): T[] {
  const min = Date.parse(nowIso) + RENTAL_LIMITS.minLeadMinutes * 60_000;
  return slots.filter(s => s.status === "open" && s.booked < s.capacity && Date.parse(s.startsAt) >= min).sort((a, b) => a.startsAt.localeCompare(b.startsAt)).slice(0, count);
}

// ---- Repairs: triage ------------------------------------------------------------------------------------------------------------

export const REPAIR_CATEGORIES = ["plumbing", "electrical", "gas", "appliance", "heating_cooling", "locks_security", "windows_doors", "roof_leaks", "pests", "structure", "other"] as const;
export type RepairCategory = (typeof REPAIR_CATEGORIES)[number];
export const REPAIR_LABELS: Record<RepairCategory, string> = {
  plumbing: "Plumbing", electrical: "Electrical", gas: "Gas", appliance: "Appliance", heating_cooling: "Heating or cooling", locks_security: "Locks and security",
  windows_doors: "Windows and doors", roof_leaks: "Roof and leaks", pests: "Pests", structure: "Walls, ceilings and structure", other: "Something else"
};
export const isRepairCategory = (v: unknown): v is RepairCategory => typeof v === "string" && (REPAIR_CATEGORIES as readonly string[]).includes(v);
export type Urgency = "emergency" | "urgent" | "routine";
export const URGENCY_LABEL: Record<Urgency, string> = { emergency: "Emergency", urgent: "Urgent", routine: "Routine" };
export interface Triage { urgency: Urgency; reason: string; trade?: EmergencyTrade; advice?: string }

const EMERGENCY_RULES: { re: RegExp; reason: string; trade: EmergencyTrade; advice: string }[] = [
  { re: /\bgas\b.*\b(?:smell|leak|leaking|hiss)|\b(?:smell|smells|smelling)\b.*\bgas\b|\brotten egg/i, reason: "Possible gas leak.", trade: "gas_fitter", advice: "Do not use switches, flames or phones inside. Leave the property, then call the gas emergency line or 000 from outside." },
  { re: /\bcarbon monoxide\b|\bco alarm\b/i, reason: "Possible carbon monoxide.", trade: "gas_fitter", advice: "Get everyone outside into fresh air and call 000." },
  { re: /\bsmoke\b|\bon fire\b|\bfire\b|\bburning smell\b|\bsmells? (?:like )?burning\b|\bsparks?\b|\bsparking\b|\bexposed wir|\blive wir|\bsmoking\b/i, reason: "Possible fire or electrical danger.", trade: "electrician", advice: "If there is fire or smoke, get out and call 000. If it is safe, switch off the power at the meter box and keep clear of the fault." },
  { re: /\bburst\b|\bflood|\bwater (?:is )?(?:pouring|gushing|everywhere)|\bgushing\b|\bpipe (?:has )?burst/i, reason: "Serious flooding or a burst pipe.", trade: "plumber", advice: "If it is safe, turn off the water at the mains and switch off power in the wet area." },
  { re: /\bsewage\b|\braw sewage\b|\bsewer\b.*\b(?:overflow|backing|backed)|\btoilets?\b.*\b(?:overflow|overflowing)\b/i, reason: "Sewage overflow.", trade: "plumber", advice: "Keep people and pets away from the area and do not use the toilets or drains." },
  { re: /\b(?:break[- ]?in|broke in|burgl|forced (?:entry|open)|door (?:is )?(?:smashed|kicked in)|window (?:is )?(?:smashed|broken)\b.*\b(?:open|secure|cannot lock)|can'?t (?:lock|secure|close)\b.*\b(?:door|window))/i, reason: "The home cannot be secured.", trade: "locksmith", advice: "If someone has broken in or you feel unsafe, call 000 first." },
  { re: /\b(?:ceiling|roof)\b.*\b(?:collaps|caved|fell|falling down)|\bcollaps/i, reason: "Possible structural collapse.", trade: "builder", advice: "Keep everyone out of the affected room and call 000 if anyone is hurt." },
  { re: /\bno (?:water|hot water)\b.*\b(?:whole|entire|any)\b.*\b(?:house|home)\b/i, reason: "No water supply.", trade: "plumber", advice: "" }
];
const URGENT_RULES: { re: RegExp; reason: string }[] = [
  { re: /\b(?:no|lost|without) (?:power|electricity|hot water|water|heating|cooling)\b|\bpower (?:is )?(?:out|off)\b|\bhot water (?:system )?(?:is )?(?:not|isn'?t|has stopped)|\b(?:hot water|heater|heating|oven|stove|cooktop|fridge|refrigerator|toilet) (?:is |has )?(?:not working|broken|stopped|dead)|\bleak(?:ing|s)?\b|\bdrip(?:ping|s)? (?:from|through)|\bblocked (?:toilet|drain|sewer)|\bmould\b|\bmold\b|\b(?:lock|key|door|window)s?\b.*\b(?:broken|jammed|stuck|won'?t|not)\b|\bpests?\b.*\b(?:infest|nest)|\bwasps?\b|\btermites?\b|\brats?\b|\bsmoke alarm\b/i, reason: "A basic service is out, something is leaking, or the home may not be secure." }
];

/**
 * Triage by fixed rules. A tenant can raise the urgency but nothing lowers an emergency. Emergencies come with a safety line first: if anyone
 * is in danger, call 000. Elena does not diagnose; she sorts so the right person is told at the right speed.
 */
export function triage(category: RepairCategory, description: string, tenantSaysEmergency = false, tenantSaysUrgent = false): Triage {
  const text = `${REPAIR_LABELS[category]} ${description}`.replace(/\s+/g, " ");
  for (const e of EMERGENCY_RULES) if (e.re.test(text)) return { urgency: "emergency", reason: e.reason, trade: e.trade, ...(e.advice ? { advice: e.advice } : {}) };
  if (tenantSaysEmergency) { const trade = defaultTrade(category); return { urgency: "emergency", reason: "The tenant marked this as an emergency.", ...(trade ? { trade } : {}), advice: "If anyone is in danger, call 000." }; }
  for (const u of URGENT_RULES) if (u.re.test(text)) return { urgency: "urgent", reason: u.reason };
  if (tenantSaysUrgent) return { urgency: "urgent", reason: "The tenant asked for this to be treated as urgent." };
  return { urgency: "routine", reason: "No safety risk or lost essential service was described." };
}

function defaultTrade(c: RepairCategory): EmergencyTrade | undefined {
  switch (c) {
    case "plumbing": return "plumber"; case "electrical": return "electrician"; case "gas": return "gas_fitter"; case "heating_cooling": return "air_conditioning";
    case "locks_security": return "locksmith"; case "windows_doors": return "glazier"; case "roof_leaks": return "roofer"; case "pests": return "pest_control"; case "structure": return "builder";
    default: return undefined;
  }
}
export const emergencyTradeFor = (category: RepairCategory, t: Triage): EmergencyTrade => t.trade ?? defaultTrade(category) ?? "builder";

export interface RepairInput { category: RepairCategory; description: string; emergency: boolean; urgent: boolean }
export function parseRepair(input: unknown): Result<RepairInput & { tenancyId: string }> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return bad("Send a JSON object.");
  const o = input as Record<string, unknown>;
  const tenancyId = typeof o["tenancyId"] === "string" && /^[0-9a-f-]{36}$/i.test(o["tenancyId"]) ? o["tenancyId"] : undefined;
  if (!tenancyId) return bad("Choose which home this is for.");
  if (!isRepairCategory(o["category"])) return bad("Choose what kind of problem it is.");
  const description = typeof o["description"] === "string" ? o["description"].trim() : "";
  if (description.length < 10 || description.length > 1000) return bad("Describe the problem in 10 to 1,000 characters.");
  const scan = scanContent(description);
  if (scan.action === "block") return bad("Leave phone numbers, email addresses and links out of the description: the owner and contractors reply through the platform.");
  const flag = (k: string) => o[k] === true || o[k] === "true" || o[k] === "on";
  return { ok: true, value: { tenancyId, category: o["category"], description, emergency: flag("emergency"), urgent: flag("urgent") } };
}

// ---- Messages -------------------------------------------------------------------------------------------------------------------

export const RENTAL_MESSAGE_KINDS = [
  "application_received", "application_owner", "info_request", "viewing_offer", "viewing_confirmed", "viewing_confirmed_owner", "viewing_reminder_24h", "viewing_reminder_2h",
  "viewing_cancelled", "viewing_cancelled_owner", "viewing_summary", "decision_shortlisted", "decision_approved", "decision_declined", "tenancy_started",
  "repair_received", "repair_owner_new", "repair_emergency_owner", "repair_proposal", "repair_offered", "repair_scheduled", "repair_notice", "repair_short_notice", "repair_chase_owner",
  "repair_contractor_declined", "repair_check", "repair_closed", "repair_needs_owner", "repair_owner_arranging", "repair_emergency_sent", "repair_emergency_accepted", "repair_emergency_quiet", "repair_reopened"
] as const;
export type RentalMessageKind = (typeof RENTAL_MESSAGE_KINDS)[number];
/** Messages that should reach the owner or tenant fast: text and push where they allow it. */
export const URGENT_KINDS: ReadonlySet<RentalMessageKind> = new Set(["repair_emergency_owner", "repair_emergency_sent", "repair_emergency_quiet", "repair_received"]);

export interface RentalVars {
  address: string; name?: string; ref?: string; when?: string; list?: string; category?: string; urgency?: string; reason?: string; advice?: string;
  rank?: string; headline?: string; missing?: string; contractor?: string; count?: number; link?: string; eta?: string;
}
export interface RentalDraft { title: string; body: string }

/** Fixed wording only, filled from stored fields. No prices, no promises about money, no contact details, nothing about who someone is. */
export function draftRental(kind: RentalMessageKind, v: RentalVars): RentalDraft {
  const hi = v.name ? `Hi ${v.name}, ` : "";
  switch (kind) {
    case "application_received": return { title: `Application received: ${v.address}`, body: `${hi}Elena has your application for ${v.address}. The owner decides, and Elena never declines anyone. ${v.missing ? `To finish it, please add ${v.missing}.` : "Nothing else is needed from you now."} ${v.list ? `Viewing times you can book: ${v.list}.` : "She will message you when viewing times are available."}`.trim() };
    case "application_owner": return { title: `New application: ${v.address}`, body: `${hi}A new application came in for ${v.address}. ${v.headline ?? ""} Open your rentals desk to compare applicants side by side. The decision is yours.`.replace(/\s+/g, " ") };
    case "info_request": return { title: `A little more needed: ${v.address}`, body: `${hi}To compare your application for ${v.address}, Elena needs ${v.missing}. Update your application when you can. Leaving something blank is fine and is not held against you.` };
    case "viewing_offer": return { title: `Viewing times: ${v.address}`, body: `${hi}You can view ${v.address} at: ${v.list}. Pick a time from your rentals page.` };
    case "viewing_confirmed": return { title: `Viewing booked: ${v.when}`, body: `${hi}Your viewing of ${v.address} is booked for ${v.when}. You can change or cancel it from your rentals page.` };
    case "viewing_confirmed_owner": return { title: `Viewing booked: ${v.when}`, body: `${v.name ?? "An applicant"} booked a viewing of ${v.address} for ${v.when}.` };
    case "viewing_reminder_24h": return { title: `Tomorrow: viewing at ${v.address}`, body: `${hi}A reminder that your viewing of ${v.address} is ${v.when}.` };
    case "viewing_reminder_2h": return { title: `Soon: viewing at ${v.address}`, body: `${hi}Your viewing of ${v.address} is ${v.when}, in about two hours.` };
    case "viewing_cancelled": return { title: `Viewing cancelled: ${v.address}`, body: `${hi}Your viewing of ${v.address} on ${v.when} was cancelled. You can book another time from your rentals page.` };
    case "viewing_cancelled_owner": return { title: `Viewing cancelled: ${v.when}`, body: `${v.name ?? "An applicant"} cancelled their viewing of ${v.address} on ${v.when}. The place is free again.` };
    case "viewing_summary": return { title: `Viewing summary: ${v.address}`, body: `The ${v.when} viewing of ${v.address} had ${v.count ?? 0} booked: ${v.list ?? "no one"}. Open your rentals desk to mark who came and compare applicants.` };
    case "decision_shortlisted": return { title: `You are on the shortlist: ${v.address}`, body: `${hi}The owner has shortlisted your application for ${v.address}. They will be in touch through the platform.` };
    case "decision_approved": return { title: `Application approved: ${v.address}`, body: `${hi}The owner has approved your application for ${v.address}. They will message you the next steps.` };
    case "decision_declined": return { title: `Application update: ${v.address}`, body: `${hi}The owner of ${v.address} has chosen another applicant. Thanks for applying.` };
    case "tenancy_started": return { title: `Repairs for ${v.address}`, body: `${hi}You can now report repairs for ${v.address} from your rentals page. Elena will sort them by urgency and keep you and the owner updated.` };
    case "repair_received": return { title: `Repair ${v.ref} received`, body: `${hi}Elena has your ${v.category} request ${v.ref} for ${v.address}. She rated it ${v.urgency}${v.reason ? `: ${v.reason}` : ""}. ${v.advice ? `${v.advice} ` : ""}The owner has been told.`.replace(/\s+/g, " ").trim() };
    case "repair_owner_new": return { title: `New repair request ${v.ref}`, body: `A tenant reported a ${v.category} problem (${v.urgency}) at ${v.address}: ${v.reason ?? "see the request"}. Open your rentals desk to review it${v.advice ? "" : ". Elena will suggest a contractor for you to approve"}.` };
    case "repair_emergency_owner": return { title: `EMERGENCY ${v.ref}: ${v.address}`, body: `A tenant reported an emergency at ${v.address} (${v.category}): ${v.reason ?? "see the request"}. Open your rentals desk now to send it to emergency contractors, or call one yourself. If anyone is in danger, call 000.` };
    case "repair_proposal": return { title: `Repair ${v.ref}: approve a contractor`, body: `Elena suggests ${v.contractor ?? "a contractor"} for ${v.category} request ${v.ref} at ${v.address}${v.reason ? ` (${v.reason})` : ""}. Approve to send the job offer, choose another, or arrange it yourself. No price is agreed on your behalf.` };
    case "repair_offered": return { title: `Repair ${v.ref}: contractor asked`, body: `${hi}Elena has asked ${v.contractor ?? "a contractor"} to look at ${v.category} request ${v.ref} at ${v.address}. You will be told when a time is set.` };
    case "repair_scheduled": return { title: `Repair ${v.ref}: visit set for ${v.when}`, body: `${hi}A visit for ${v.category} request ${v.ref} at ${v.address} is set for ${v.when}.` };
    case "repair_notice": return { title: `Entry notice: ${v.address}`, body: `${hi}A contractor will visit ${v.address} for repair ${v.ref} on ${v.when}. This is your entry notice. If that time does not suit you, tell the owner on your rentals page.` };
    case "repair_short_notice": return { title: `Repair ${v.ref}: is ${v.when} OK?`, body: `${hi}A contractor can visit ${v.address} for repair ${v.ref} on ${v.when}, which is less than 24 hours away. Nobody will enter unless you agree. Open your rentals page to say yes, or ask for another time.` };
    case "repair_chase_owner": return { title: `Waiting on you: repair ${v.ref}`, body: `${hi}Repair ${v.ref} (${v.category}, ${v.urgency}) at ${v.address} is still waiting for you. Open your rentals desk to approve the contractor Elena suggested or choose another.` };
    case "repair_contractor_declined": return { title: `Repair ${v.ref}: contractor unavailable`, body: `${v.contractor ?? "The contractor"} could not take repair ${v.ref} at ${v.address}. ${v.reason ? `Elena suggests ${v.reason} next. ` : ""}Open your rentals desk to approve or choose someone else.` };
    case "repair_check": return { title: `Is repair ${v.ref} fixed?`, body: `${hi}The visit for repair ${v.ref} at ${v.address} was due. Has the problem been fixed? Tell Elena on your rentals page.` };
    case "repair_closed": return { title: `Repair ${v.ref} closed`, body: `Repair ${v.ref} at ${v.address} is closed. If the problem comes back, report it again from your rentals page.` };
    case "repair_needs_owner": return { title: `Elena needs you: repair ${v.ref}`, body: `Elena has stopped chasing repair ${v.ref} at ${v.address}. ${v.reason ?? "Please take a look."}` };
    case "repair_owner_arranging": return { title: `Repair ${v.ref}: owner is arranging it`, body: `${hi}The owner will arrange repair ${v.ref} at ${v.address} directly. Elena will check back with you to make sure it gets fixed.` };
    case "repair_emergency_sent": return { title: `Emergency ${v.ref}: contractors asked`, body: `${hi}Emergency request ${v.ref} for ${v.address} has gone to emergency contractors available now. Replies appear on the owner's emergency page. If anyone is in danger, call 000.` };
    case "repair_emergency_accepted": return { title: `Emergency ${v.ref}: a contractor accepted`, body: `A contractor accepted emergency ${v.ref} at ${v.address}${v.eta ? ` and expects to arrive in about ${v.eta}` : ""}. The owner has their details.` };
    case "repair_emergency_quiet": return { title: `Emergency ${v.ref}: nobody has accepted yet`, body: `No contractor has accepted emergency ${v.ref} at ${v.address}. Search the emergency directory and call one directly. If anyone is in danger, call 000.` };
    case "repair_reopened": return { title: `Repair ${v.ref} reopened`, body: `The tenant says repair ${v.ref} at ${v.address} is not fixed. It is back on your list.` };
  }
}

export const MAX_RENTAL_MESSAGES_PER_DAY = 8;
/** Contact details, abuse and spam block the send; amounts of money are never sent. Same checker as Elena's contractor messages. */
export { checkOutbound as checkRentalOutbound, rateLimited as rentalRateLimited };

// ---- Repairs: what happens next -------------------------------------------------------------------------------------------------

export type RepairStatus = "awaiting_owner" | "offered" | "scheduled" | "emergency" | "owner_arranging" | "check_in" | "needs_owner" | "closed";
export interface RepairState { id: string; status: RepairStatus; urgency: Urgency; chases: number; nextActionAt?: string }
export interface RepairContext {
  assignmentStatus: "none" | "proposed" | "approved" | "completed" | "cancelled";
  scheduledAt?: string;
  /** When the job offer went out. */
  offeredAt?: string;
  /** For an emergency: the request's state in the emergency flow. */
  emergency?: { status: "open" | "accepted" | "cancelled" | "expired"; ageMinutes: number; quietNotified: boolean };
}
export type RepairStep =
  | { type: "send"; to: "owner" | "tenant"; kind: RentalMessageKind; vars?: Partial<RentalVars> }
  | { type: "set"; patch: { status?: RepairStatus; chases?: number; nextActionAt?: string | null; reason?: string; reopenProposal?: boolean } };

const plus = (now: string, ms: number) => new Date(new Date(now).getTime() + ms).toISOString();
const HOUR = 3600_000;
/** How often Elena nudges the owner: emergencies and urgent repairs sooner. */
export const chaseGapMs = (u: Urgency): number => (u === "emergency" ? 1 * HOUR : u === "urgent" ? 6 * HOUR : 24 * HOUR);

/** What a repair needs now. Called for repairs whose next action time has passed. Chases are capped; after that the owner is told and Elena stops. */
export function repairDue(r: RepairState, ctx: RepairContext, now: string): RepairStep[] {
  if (r.status === "closed" || r.status === "needs_owner") return [];
  const handBack = (reason: string): RepairStep[] => [{ type: "set", patch: { status: "needs_owner", nextActionAt: null, reason } }, { type: "send", to: "owner", kind: "repair_needs_owner", vars: { reason } }];
  const chase = (): RepairStep[] => r.chases >= RENTAL_LIMITS.repairChaseMax
    ? handBack("Elena reminded you three times. She has stopped so she does not keep messaging you. Reopen it from the repair when you are ready.")
    : [{ type: "set", patch: { chases: r.chases + 1, nextActionAt: plus(now, chaseGapMs(r.urgency)) } }, { type: "send", to: "owner", kind: "repair_chase_owner" }];
  switch (r.status) {
    case "awaiting_owner": return chase();
    case "offered": {
      if (ctx.assignmentStatus === "cancelled") return [{ type: "set", patch: { status: "awaiting_owner", chases: 0, nextActionAt: plus(now, chaseGapMs(r.urgency)), reopenProposal: true } }, { type: "send", to: "owner", kind: "repair_contractor_declined" }];
      if (ctx.assignmentStatus === "completed") return [{ type: "set", patch: { status: "check_in", chases: 0, nextActionAt: now } }];
      if (ctx.assignmentStatus === "approved" && ctx.scheduledAt) return [
        { type: "set", patch: { status: "scheduled", chases: 0, nextActionAt: plus(ctx.scheduledAt, 2 * HOUR) } },
        { type: "send", to: "tenant", kind: "repair_scheduled", vars: { when: ctx.scheduledAt } }, { type: "send", to: "owner", kind: "repair_scheduled", vars: { when: ctx.scheduledAt } }
      ];
      // Still waiting on the contractor (the job flow chases them). Checked every two hours; the owner is nudged after each full chase gap since the
      // offer went out, and after three gaps the repair goes back to the owner.
      {
        const gap = chaseGapMs(r.urgency);
        const n = Math.floor((new Date(now).getTime() - new Date(ctx.offeredAt ?? now).getTime()) / gap);
        if (n >= RENTAL_LIMITS.repairChaseMax) return handBack("The contractor has not answered or agreed a time. Choose someone else.");
        const next = { type: "set", patch: { nextActionAt: plus(now, r.urgency === "emergency" ? HOUR / 2 : 2 * HOUR), ...(n > r.chases ? { chases: n } : {}) } } as RepairStep;
        return n > r.chases ? [next, { type: "send", to: "owner", kind: "repair_chase_owner" }] : [next];
      }
    }
    case "scheduled":
      if (ctx.assignmentStatus === "cancelled") return [{ type: "set", patch: { status: "awaiting_owner", chases: 0, nextActionAt: plus(now, chaseGapMs(r.urgency)), reopenProposal: true } }, { type: "send", to: "owner", kind: "repair_contractor_declined" }];
      if (ctx.scheduledAt && new Date(ctx.scheduledAt).getTime() + 2 * HOUR > new Date(now).getTime()) return [{ type: "set", patch: { nextActionAt: plus(ctx.scheduledAt, 2 * HOUR) } }];
      return [{ type: "set", patch: { status: "check_in", chases: 0, nextActionAt: now } }];
    case "owner_arranging": return [{ type: "set", patch: { status: "check_in", chases: 0, nextActionAt: now } }];
    case "check_in":
      return r.chases >= RENTAL_LIMITS.repairChaseMax ? handBack("The tenant has not said whether it was fixed after three check-ins. Please check with them.")
        : [{ type: "set", patch: { chases: r.chases + 1, nextActionAt: plus(now, 24 * HOUR) } }, { type: "send", to: "tenant", kind: "repair_check" }];
    case "emergency": {
      const e = ctx.emergency;
      if (!e) return chase();
      if (e.status === "accepted") return [{ type: "set", patch: { status: "check_in", chases: 0, nextActionAt: plus(now, 3 * HOUR) } }, { type: "send", to: "owner", kind: "repair_emergency_accepted" }, { type: "send", to: "tenant", kind: "repair_emergency_accepted" }];
      if (e.status === "cancelled") return [{ type: "set", patch: { status: "awaiting_owner", chases: 0, nextActionAt: plus(now, chaseGapMs("emergency")) } }];
      if (e.status === "expired") return handBack("No emergency contractor accepted in time. Search the directory and call one directly. If anyone is in danger, call 000.");
      if (e.ageMinutes >= 30 && !e.quietNotified) return [{ type: "set", patch: { nextActionAt: plus(now, 30 * 60_000) } }, { type: "send", to: "owner", kind: "repair_emergency_quiet" }, { type: "send", to: "tenant", kind: "repair_emergency_quiet" }];
      return [{ type: "set", patch: { nextActionAt: plus(now, 10 * 60_000) } }];
    }
    default: return [];
  }
}

/** A visit more than 24 hours away needs no consent from the tenant (a platform minimum; state law differs). Sooner than that, nobody enters unless the tenant agrees. */
export const TENANT_NOTICE_HOURS = 24;
export const needsTenantConsent = (visitAt: string, now: string, emergency: boolean): boolean => !emergency && new Date(visitAt).getTime() - new Date(now).getTime() < TENANT_NOTICE_HOURS * HOUR;
