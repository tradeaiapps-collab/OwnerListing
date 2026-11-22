import type { Failure, Result } from "./listing-service";

/** Trades that can have a public contractor page. `other` carries the contractor's own trade label (for example "Cleaner"). */
export const TRADES = ["photographer", "inspector", "pest_control", "other"] as const;
export type Trade = typeof TRADES[number];
export const TRADE_LABELS: Record<Trade, string> = { photographer: "Photographer", inspector: "Building inspector", pest_control: "Pest control", other: "Other trade" };
export const isTrade = (v: unknown): v is Trade => typeof v === "string" && (TRADES as readonly string[]).includes(v);

export const formatContractorNo = (n: number): string => `CON-${n}`;
export const formatJobNo = (n: number): string => `JOB-${n}`;

/** Finds a job number such as JOB-5001 in an email subject or body. Case and one space or no dash are tolerated. */
export function parseJobNumber(text: string): number | undefined {
  const m = /\bJOB[-\s]?(\d{4,9})\b/i.exec(text);
  return m?.[1] ? Number(m[1]) : undefined;
}
/** CON-2001, con 2001 or 2001. */
export function parseContractorNumber(text: string): number | undefined {
  const m = /^\s*(?:CON[-\s]?)?(\d{4,9})\s*$/i.exec(text);
  return m?.[1] ? Number(m[1]) : undefined;
}

export type PriceType = "fixed" | "from" | "per_hour";
export interface ServiceInput { kind: Trade; name: string; description: string; priceCents: number; priceType: PriceType }
export interface MediaInput { mediaType: "photo" | "video"; url: string; caption: string }
export interface PageInput {
  businessName: string; headline: string; about: string; tradeLabel: string;
  licenceNumber: string; licenceState: string; isPublic: boolean;
  services: ServiceInput[]; media: MediaInput[];
}
const STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"];
const bad = (message: string): Failure => ({ ok: false, code: "invalid", message });

/** "Displayed price" text: "$180", "from $180" or "$90 per hour". Cents are whole dollars only when they are. */
export function formatPrice(cents: number, type: PriceType = "fixed"): string {
  const dollars = cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
  const base = `$${Number(dollars).toLocaleString("en-AU", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2 })}`;
  return type === "from" ? `from ${base}` : type === "per_hour" ? `${base} per hour` : base;
}

/** Validates the contractor's own page body. The user id never comes from here. */
export function parsePageInput(input: unknown): Result<PageInput> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return bad("Send a JSON object.");
  const o = input as Record<string, unknown>;
  const str = (k: string, max: number): string | undefined => {
    const v = o[k] ?? "";
    return typeof v === "string" && v.trim().length <= max ? v.trim() : undefined;
  };
  const businessName = str("businessName", 100), headline = str("headline", 140), about = str("about", 3000), tradeLabel = str("tradeLabel", 60);
  const licenceNumber = str("licenceNumber", 40), licenceState = str("licenceState", 3);
  if (businessName === undefined || headline === undefined || about === undefined || tradeLabel === undefined || licenceNumber === undefined || licenceState === undefined) {
    return bad("One of the text fields is too long. Business name 100, headline 140, about 3000, trade 60, licence 40 characters.");
  }
  if (licenceState !== "" && !STATES.includes(licenceState.toUpperCase())) return bad("Licence state must be NSW, VIC, QLD, WA, SA, TAS, ACT or NT.");
  if (typeof (o["isPublic"] ?? false) !== "boolean") return bad("isPublic must be true or false.");
  const servicesIn = o["services"] ?? [], mediaIn = o["media"] ?? [];
  if (!Array.isArray(servicesIn) || servicesIn.length > 40) return bad("Add up to 40 services.");
  if (!Array.isArray(mediaIn) || mediaIn.length > 30) return bad("Add up to 30 photos and videos.");
  const services: ServiceInput[] = [];
  for (const s of servicesIn as Record<string, unknown>[]) {
    if (typeof s !== "object" || s === null) return bad("Each service needs a trade, name and price.");
    const price = typeof s["priceDollars"] === "number" ? Math.round(s["priceDollars"] * 100) : typeof s["priceCents"] === "number" ? s["priceCents"] : NaN;
    const name = typeof s["name"] === "string" ? s["name"].trim() : "", description = typeof s["description"] === "string" ? s["description"].trim() : "";
    const priceType = s["priceType"] ?? "fixed";
    if (!isTrade(s["kind"]) || name.length < 1 || name.length > 100 || description.length > 500) return bad("Each service needs a trade, a name up to 100 characters and a description up to 500.");
    if (!Number.isInteger(price) || price < 0 || price > 100_000_000) return bad("Prices must be between $0 and $1,000,000.");
    if (priceType !== "fixed" && priceType !== "from" && priceType !== "per_hour") return bad("Price type must be fixed, from or per_hour.");
    services.push({ kind: s["kind"], name, description, priceCents: price, priceType });
  }
  const media: MediaInput[] = [];
  for (const m of mediaIn as Record<string, unknown>[]) {
    if (typeof m !== "object" || m === null) return bad("Each photo or video needs a link.");
    const url = typeof m["url"] === "string" ? m["url"].trim() : "", caption = typeof m["caption"] === "string" ? m["caption"].trim() : "";
    if ((m["mediaType"] !== "photo" && m["mediaType"] !== "video") || !/^https:\/\/[^\s]+$/.test(url) || url.length > 500 || caption.length > 140) {
      return bad("Photos and videos need a secure (https) link and a caption up to 140 characters.");
    }
    media.push({ mediaType: m["mediaType"], url, caption });
  }
  return { ok: true, value: { businessName, headline, about, tradeLabel, licenceNumber, licenceState: licenceState.toUpperCase(), isPublic: (o["isPublic"] ?? false) as boolean, services, media } };
}

// ---- Stats -------------------------------------------------------------------------------------------------------------------

export interface JobCounts { received: number; accepted: number; rejected: number; completed: number; pending: number; thisMonth: number; avgResponseMinutes: number | null }
export interface ContractorStats extends JobCounts { completionRate: number | null; ratingAvg: number | null; ratingCount: number }
/** Completion rate is completed over accepted, as a whole percent. Nothing is shown as a rate until a job has been accepted. */
export function buildStats(c: JobCounts, rating: { avg: number | null; count: number }): ContractorStats {
  return {
    ...c,
    avgResponseMinutes: c.avgResponseMinutes === null ? null : Math.round(c.avgResponseMinutes),
    completionRate: c.accepted > 0 ? Math.min(100, Math.round((c.completed / c.accepted) * 100)) : null,
    ratingAvg: rating.avg === null || rating.count === 0 ? null : Math.round(rating.avg * 10) / 10,
    ratingCount: rating.count
  };
}
export function formatResponse(minutes: number | null): string {
  if (minutes === null) return "No answers yet";
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const h = minutes / 60;
  return h < 48 ? `${Math.round(h * 10) / 10} hours` : `${Math.round(h / 24)} days`;
}

// ---- Choosing and ranking ----------------------------------------------------------------------------------------------------

export interface MarketCard {
  userId: string; contractorNo: number; name: string; trade: Trade; tradeLabel: string; headline: string;
  suburbs: string[]; postcodes: string[]; acceptingNew: boolean; openJobs: number;
  fromPriceCents: number | null; ratingAvg: number | null; ratingCount: number; licenceVerified: boolean; completed: number;
}
export interface Ranked { card: MarketCard; score: number; reasons: string[] }

/**
 * Elena's suggestion: only contractors who work in the listing's suburb or postcode and take new jobs.
 * Area counts most, then rating (unrated is neutral), then a lower displayed price, then a lighter workload.
 * Repeatable: ties fall back to the contractor number.
 */
export function rankContractors(area: { suburb?: string; postcode?: string }, cards: readonly MarketCard[], excludeUserId?: string): Ranked[] {
  const suburb = area.suburb?.trim().toLowerCase() ?? "", postcode = area.postcode?.trim() ?? "";
  const matches = cards.flatMap(card => {
    if (!card.acceptingNew || card.userId === excludeUserId) return [];
    const bySuburb = suburb !== "" && card.suburbs.some(s => s.trim().toLowerCase() === suburb);
    const byPostcode = postcode !== "" && card.postcodes.includes(postcode);
    return bySuburb || byPostcode ? [{ card, bySuburb }] : [];
  });
  const prices = matches.flatMap(m => (m.card.fromPriceCents === null ? [] : [m.card.fromPriceCents]));
  const lo = Math.min(...prices), hi = Math.max(...prices);
  return matches.map(({ card, bySuburb }) => {
    const reasons = [bySuburb ? "Works in your suburb" : "Works in your postcode"];
    let score = bySuburb ? 40 : 28;
    const rating = card.ratingAvg === null ? 3.5 : card.ratingAvg;
    score += (rating / 5) * 30;
    if (card.ratingAvg !== null) reasons.push(`${card.ratingAvg} stars from ${card.ratingCount} review${card.ratingCount === 1 ? "" : "s"}`);
    if (card.fromPriceCents !== null) {
      score += hi === lo ? 15 : (1 - (card.fromPriceCents - lo) / (hi - lo)) * 20;
      reasons.push(`Price from ${formatPrice(card.fromPriceCents)}`);
    }
    score += Math.max(0, 10 - card.openJobs * 2);
    reasons.push(card.openJobs === 0 ? "Free to start now" : `${card.openJobs} open job${card.openJobs === 1 ? "" : "s"}`);
    if (card.licenceVerified) { score += 3; reasons.push("Licence verified"); }
    return { card, score: Math.round(score * 10) / 10, reasons };
  }).sort((a, b) => b.score - a.score || a.card.contractorNo - b.card.contractorNo);
}

// ---- Job actions and files ---------------------------------------------------------------------------------------------------

/** The file kind for a contractor's emailed or uploaded file, from the trade and the real type. Undefined when this trade may not send it. */
export function uploadKindFor(trade: string, mime: string, hint: string): "photo" | "video" | "floorplan" | "building_inspection" | "pest_report" | "other" | undefined {
  const h = hint.toLowerCase();
  if (trade === "photographer" || trade === "agent") {
    if (mime.startsWith("image/")) return h.includes("floor") ? "floorplan" : "photo";
    if (mime.startsWith("video/")) return "video";
    return mime === "application/pdf" && h.includes("floor") ? "floorplan" : undefined;
  }
  if (trade === "inspector") return mime === "application/pdf" ? (h.includes("pest") || h.includes("termite") ? "pest_report" : "building_inspection") : undefined;
  if (trade === "pest_control") return mime === "application/pdf" ? "pest_report" : mime.startsWith("image/") ? "photo" : undefined;
  if (trade === "other") return mime.startsWith("image/") ? "photo" : mime === "application/pdf" ? "other" : undefined;
  return undefined;
}

export function parseReview(input: unknown): Result<{ rating: number; body: string }> {
  if (typeof input !== "object" || input === null) return bad("Send a JSON object.");
  const o = input as Record<string, unknown>;
  const rating = o["rating"], body = typeof (o["body"] ?? "") === "string" ? String(o["body"] ?? "").trim() : undefined;
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) return bad("Rating must be 1 to 5 stars.");
  if (body === undefined || body.length > 1000) return bad("Feedback must be 1000 characters or fewer.");
  return { ok: true, value: { rating, body } };
}
