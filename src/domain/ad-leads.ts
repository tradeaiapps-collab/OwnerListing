import { createHmac, timingSafeEqual } from "node:crypto";
import { renderEmail, type RenderedEmail } from "./email-templates";
import { cleanPropertyType } from "./ad-lead-routing";

/**
 * Lead ads: Facebook/Instagram Lead Ads and Google lead form extensions. Pure functions, no I/O.
 * A lead is someone who filled in an ad form. We keep only what the form asked for (name, email, phone, interest, optional area).
 */

export type LeadProvider = "meta" | "google";
export type LeadInterest = "buying" | "selling" | "renting";
export type LeadStatus = "new" | "contacted" | "qualified" | "lost";
export type FollowupMode = "off" | "contact" | "matches";
export const LEAD_STATUSES: readonly LeadStatus[] = ["new", "contacted", "qualified", "lost"];
export const isLeadStatus = (v: unknown): v is LeadStatus => typeof v === "string" && (LEAD_STATUSES as readonly string[]).includes(v);
export const FOLLOWUP_MODES: readonly FollowupMode[] = ["off", "contact", "matches"];

export const LEAD_LIMITS = { maxWebhookBytes: 256 * 1024, maxSpendDays: 366 } as const;

export interface LeadInput {
  externalId: string; name: string | null; email: string | null; phone: string | null; interest: LeadInterest | null;
  suburb: string | null; postcode: string | null; propertyType?: string | null; campaignRef: string | null; adRef: string | null; isTest: boolean;
}
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = String(v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t === "" ? null : t.slice(0, max);
};

// ---- Field clean-up ----

export function normaliseEmail(v: unknown): string | null {
  const t = str(v, 254)?.toLowerCase() ?? null;
  return t && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/.test(t) ? t : null;
}
/** Australian numbers to +61…; other international numbers kept as +digits; anything else is dropped rather than guessed. */
export function normalisePhone(v: unknown): string | null {
  const raw = str(v, 40);
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  const plus = digits.startsWith("+");
  const d = digits.replace(/\D/g, "");
  if (plus) return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  if (d.startsWith("0") && d.length === 10) return `+61${d.slice(1)}`;
  if (d.startsWith("61") && d.length === 11) return `+${d}`;
  return null;
}
export function normaliseInterest(v: unknown): LeadInterest | null {
  const t = str(v, 120)?.toLowerCase();
  if (!t) return null;
  if (/\bsell|selling|list(ing)? my|appraisal|valuation/.test(t)) return "selling";
  if (/\brent|renting|lease|tenant/.test(t)) return "renting";
  if (/\bbuy|buying|purchase|looking to buy/.test(t)) return "buying";
  return null;
}
const postcodeOf = (v: unknown): string | null => { const t = str(v, 12); return t && /^\d{4}$/.test(t) ? t : null; };

/** Reads form answers by a loose name match so the field names an advertiser picked in the ad form do not matter. */
function fromAnswers(answers: { key: string; value: string }[]): Pick<LeadInput, "name" | "email" | "phone" | "interest" | "suburb" | "postcode" | "propertyType"> {
  const find = (re: RegExp) => answers.find(a => re.test(a.key.toLowerCase().replace(/[\s_-]+/g, "")))?.value ?? null;
  const first = find(/^(first|given)name$/), last = find(/^(last|sur|family)name$/);
  const full = find(/^(full)?name$/) ?? find(/fullname/) ?? (first || last ? [first, last].filter(Boolean).join(" ") : null);
  return {
    name: str(full, 120), email: normaliseEmail(find(/email/)), phone: normalisePhone(find(/phone|mobile/)),
    interest: normaliseInterest(find(/interest|looking|want|intent|buyingselling|areyou/)),
    suburb: str(find(/suburb|city|town/), 80), postcode: postcodeOf(find(/post(al)?code|zip/)), propertyType: cleanPropertyType(find(/propertytype|typeofproperty|propertykind/))
  };
}
function finish(externalId: unknown, answers: { key: string; value: string }[], extra: { campaignRef: unknown; adRef: unknown; isTest: boolean }): Parsed<LeadInput> {
  const id = str(externalId, 200);
  if (!id) return fail("The lead has no id.");
  const f = fromAnswers(answers);
  if (!f.email && !f.phone) return fail("The lead has no usable email or phone.");
  return { ok: true, value: { externalId: id, ...f, campaignRef: str(extra.campaignRef, 120), adRef: str(extra.adRef, 120), isTest: extra.isTest } };
}

// ---- Meta (Facebook / Instagram) ----

export interface MetaLeadRef { leadgenId: string; pageId: string; formId: string | null; adId: string | null }

/** The Page leadgen events in a Meta webhook body. Anything else in the body is ignored. */
export function parseMetaWebhook(body: unknown): MetaLeadRef[] {
  if (!isRec(body) || !Array.isArray(body["entry"])) return [];
  const out: MetaLeadRef[] = [];
  for (const e of body["entry"]) {
    if (!isRec(e) || !Array.isArray(e["changes"])) continue;
    for (const c of e["changes"]) {
      if (!isRec(c) || c["field"] !== "leadgen" || !isRec(c["value"])) continue;
      const v = c["value"];
      const leadgenId = str(v["leadgen_id"], 64), pageId = str(v["page_id"] ?? e["id"], 64);
      if (leadgenId && pageId) out.push({ leadgenId, pageId, formId: str(v["form_id"], 64), adId: str(v["ad_id"], 64) });
    }
  }
  return out.slice(0, 100);
}

/** True when `header` ("sha256=<hex>") is the HMAC-SHA256 of the raw body under the app secret. Constant time. */
export function verifyMetaSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !appSecret || !header.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice(7), "hex");
  const want = createHmac("sha256", appSecret).update(rawBody).digest();
  return given.length === want.length && timingSafeEqual(given, want);
}

/** A lead as the Graph API returns it: { id, ad_id, form_id, campaign_id, is_organic, field_data: [{ name, values: [] }] }. */
export function mapMetaLead(graph: unknown, ref?: MetaLeadRef): Parsed<LeadInput> {
  if (!isRec(graph) || !Array.isArray(graph["field_data"])) return fail("Meta sent a lead in an unexpected shape.");
  const answers = graph["field_data"].flatMap(f => (isRec(f) && Array.isArray(f["values"]) && str(f["name"], 120) && str(f["values"][0], 400) ? [{ key: str(f["name"], 120)!, value: str(f["values"][0], 400)! }] : []));
  return finish(graph["id"] ?? ref?.leadgenId, answers, { campaignRef: graph["campaign_name"] ?? graph["campaign_id"], adRef: graph["ad_name"] ?? graph["ad_id"] ?? ref?.adId, isTest: false });
}

// ---- Google lead form extensions ----

export interface GoogleLeadBody { googleKey: string | null; lead: Parsed<LeadInput> }
/** Google's webhook body: { lead_id, google_key, is_test, campaign_id, creative_id, user_column_data: [{ column_id, column_name, string_value }] }. */
export function mapGoogleLead(body: unknown): GoogleLeadBody {
  if (!isRec(body) || !Array.isArray(body["user_column_data"])) return { googleKey: null, lead: fail("Google sent a lead in an unexpected shape.") };
  const answers = body["user_column_data"].flatMap(c => {
    if (!isRec(c) || !str(c["string_value"], 400)) return [];
    // Standard columns have ids like FULL_NAME / EMAIL / PHONE_NUMBER / POSTAL_CODE; custom questions carry the question text in column_name.
    const key = str(c["column_id"], 120) ?? str(c["column_name"], 120);
    const named = str(c["column_name"], 120);
    return key ? [{ key: /^question/i.test(key) && named ? named : key, value: str(c["string_value"], 400)! }] : [];
  });
  return { googleKey: str(body["google_key"], 200), lead: finish(body["lead_id"], answers, { campaignRef: body["campaign_id"], adRef: body["creative_id"] ?? body["adgroup_id"], isTest: body["is_test"] === true }) };
}

// ---- Staff input ----

export interface SourceInput { provider: LeadProvider; label: string; accountRef: string; defaultAgentId: string | null; followupMode: FollowupMode }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export function parseSourceInput(body: unknown): Parsed<SourceInput> {
  if (!isRec(body)) return fail("Send the source details.");
  if (body["provider"] !== "meta" && body["provider"] !== "google") return fail("Source must be Facebook/Instagram or Google.");
  const label = str(body["label"], 80);
  if (!label || label.length < 2) return fail("Give the source a name of at least 2 characters.");
  const accountRef = str(body["accountRef"], 64) ?? "";
  const ref = body["provider"] === "google" ? accountRef.replace(/-/g, "") : accountRef;
  if (!/^\d{5,20}$/.test(ref)) return fail(body["provider"] === "meta" ? "The Facebook Page id is digits only." : "The Google Ads customer id is digits only (dashes are fine).");
  const agent = body["defaultAgentId"];
  if (agent !== undefined && agent !== null && agent !== "" && !isUuid(agent)) return fail("Pick an agent from the list.");
  const mode = body["followupMode"] ?? "off";
  if (!FOLLOWUP_MODES.includes(mode as FollowupMode)) return fail("Follow-up must be off, contact details or property matches.");
  return { ok: true, value: { provider: body["provider"], label, accountRef: ref, defaultAgentId: isUuid(agent) ? agent : null, followupMode: mode as FollowupMode } };
}

export function parseSpendInput(body: unknown): Parsed<{ rows: { day: string; spendCents: number }[] }> {
  if (!isRec(body) || !Array.isArray(body["rows"]) || body["rows"].length === 0) return fail("Enter at least one day of spend.");
  if (body["rows"].length > LEAD_LIMITS.maxSpendDays) return fail(`Up to ${LEAD_LIMITS.maxSpendDays} days at a time.`);
  const rows: { day: string; spendCents: number }[] = [];
  const seen = new Set<string>();
  for (const r of body["rows"]) {
    const day = isRec(r) ? str(r["day"], 10) : null;
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return fail("Each day must be a date like 2026-11-05.");
    if (seen.has(day)) return fail(`${day} appears twice.`);
    seen.add(day);
    const dollars = isRec(r) ? Number(r["spend"]) : NaN;
    const cents = Math.round(dollars * 100);
    if (!Number.isFinite(dollars) || cents < 0 || cents > 100_000_000) return fail("Spend must be a dollar amount from 0 to 1,000,000.");
    rows.push({ day, spendCents: cents });
  }
  return { ok: true, value: { rows } };
}

// ---- Figures ----

export interface SourceFigures { leads: number; contacted: number; enquired: number; offered: number; spendCents: number }
export interface FiguresView extends SourceFigures {
  /** Null while there is nothing to divide by, or no spend recorded. Never 0 as a stand-in. */
  costPerLeadCents: number | null; costPerEnquiryCents: number | null; contactRate: number | null; enquiryRate: number | null; offerRate: number | null;
}
const div = (a: number, b: number): number | null => (b > 0 ? a / b : null);
export function figuresView(f: SourceFigures): FiguresView {
  return {
    ...f,
    costPerLeadCents: f.spendCents > 0 && f.leads > 0 ? Math.round(f.spendCents / f.leads) : null,
    costPerEnquiryCents: f.spendCents > 0 && f.enquired > 0 ? Math.round(f.spendCents / f.enquired) : null,
    contactRate: div(f.contacted, f.leads), enquiryRate: div(f.enquired, f.leads), offerRate: div(f.offered, f.leads)
  };
}
/** The furthest step a lead has reached. Enquiry and offer come from the matching account; the rest is staff's own status. */
export function leadStage(l: { status: LeadStatus; enquired: boolean; offered: boolean }): "offer" | "enquiry" | LeadStatus {
  return l.offered ? "offer" : l.enquired ? "enquiry" : l.status;
}

export const aud = (cents: number | null): string => (cents === null ? "—" : new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100));

// ---- Auto follow-up email ----

export interface MatchItem { id: string; title: string; address: string; priceCents: number | null; transactionType: "sale" | "rent" }
export interface FollowupInput {
  brand: string; appUrl: string | null; leadName: string | null; interest: LeadInterest | null;
  agent: { name: string; email: string | null } | null; matches: readonly MatchItem[];
}
const priceText = (m: MatchItem) => (m.priceCents === null ? "" : m.transactionType === "rent" ? ` — ${aud(m.priceCents)} a week` : ` — ${aud(m.priceCents)}`);

/** One short, plain email answering the form the person just sent. Every value is escaped by renderEmail. */
export function renderFollowup(i: FollowupInput): RenderedEmail {
  const hello = i.leadName ? `Hi ${i.leadName.split(" ")[0]},` : "Hi,";
  const topic = i.interest === "selling" ? "selling your property" : i.interest === "renting" ? "renting" : "buying";
  const lines = [hello, "", `Thanks for your interest in ${topic} through ${i.brand}.`];
  const base = i.appUrl?.replace(/\/+$/, "") ?? null;
  const list = i.matches.slice(0, 3);
  if (list.length) {
    lines.push("", "A few properties that may suit you:", ...list.map(m => `• ${m.title}, ${m.address}${priceText(m)}${base ? `\n  ${base}/listings/${m.id}` : ""}`));
  }
  if (i.agent) lines.push("", `${i.agent.name} will be in touch${i.agent.email ? `, or you can write to ${i.agent.email}` : ""}.`);
  else lines.push("", "One of our team will be in touch soon.");
  lines.push("", "No reply is needed. If this was not you, ignore this email and we will not contact you again.");
  return renderEmail({
    brand: i.brand, title: list.length ? "Properties that may suit you" : `Thanks for your interest in ${topic}`, body: lines.join("\n"),
    actionUrl: base && list.length ? `${base}/listings` : null, actionLabel: "Browse properties",
    reason: "You are receiving this once because you filled in one of our ads' forms. We will not email you again unless you reply."
  });
}
