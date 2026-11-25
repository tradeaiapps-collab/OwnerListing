import type { PropertyListing } from "./listing";
import { AMENITIES, AMENITY_LABELS, formatPrice, type Amenity } from "./listing-details";
import { checkRealText } from "./text-quality";
import { flagKey, type FieldFlags } from "./discrimination-filter";

/**
 * Elena's publish review (pure). She checks what a staff admin would check before accepting a listing: required fields,
 * photos, whether the description agrees with the form (bedrooms, bathrooms, parking, price, features), wording, the site plan
 * and the compliance reasons from the publish gate. "block" findings stop publishing; "advice" findings do not.
 * Client-safe: no node imports.
 */
export type FindingSeverity = "block" | "advice";
export type FindingArea = "details" | "description" | "photos" | "siteplan" | "wording" | "compliance";
export interface ElenaFinding {
  id: string;
  severity: FindingSeverity;
  area: FindingArea;
  message: string;
  /** Where the owner goes to fix it (edit page anchor or another page). */
  fixHref: string;
}
export interface ElenaReview { ready: boolean; findings: ElenaFinding[]; blockers: number; advice: number }

/** Photo facts the server reads from the current gallery. Hidden photos are excluded by the caller. */
export interface ElenaPhotoFacts {
  photos: { width: number; height: number; alt: string; category: string }[];
  floorplans: number;
}

export interface ElenaInput {
  listing: Pick<PropertyListing, "id" | "title" | "address" | "description" | "propertyType" | "transactionType" | "useClass" | "suburb" | "postcode" | "priceCents" | "bedrooms" | "bathrooms" | "parking" | "amenities">;
  photos: ElenaPhotoFacts;
  wordingFlags: readonly FieldFlags[];
  /** flagKey values staff cleared for this listing. */
  clearedWording: ReadonlySet<string>;
  /** Reasons the publish gate refused (disclosures, terms, fee, trust account, licence). */
  gateReasons: readonly string[];
}

const HOME_TYPES = ["house", "unit", "townhouse"];
export const MIN_PHOTOS = 5;
export const COVER_MIN_WIDTH = 1000;
export const DESCRIPTION_MIN = 80;

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const num = (s: string): number | undefined => (/^\d+$/.test(s) ? Number(s) : NUMBER_WORDS[s.toLowerCase()]);
const COUNT = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)";

/** Every "4 bedroom", "four-bed", "3 bathrooms", "2 car spaces" style count in the text. */
export function countsIn(text: string, noun: "bed" | "bath" | "car"): number[] {
  const unit = noun === "bed" ? "(?:bed(?:room)?s?|br)" : noun === "bath" ? "(?:bath(?:room)?s?)" : "(?:car\\s*(?:spaces?|ports?|parks?|garage)|garage\\s*spaces?|parking\\s*spaces?|car)";
  const out: number[] = [];
  for (const m of text.matchAll(new RegExp(`\\b${COUNT}[\\s-]*${unit}\\b`, "gi"))) {
    const n = num(m[1]!);
    if (n !== undefined) out.push(n);
  }
  return out;
}

/** Dollar amounts written in the text ("$850,000", "$1.2m", "$650 per week"), in whole dollars. */
export function dollarAmountsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(k|m)?\b/gi)) {
    let v = Number(m[1]!.replace(/,/g, "")) + (m[2] ? Number(`0.${m[2]}`) : 0);
    if (m[3]?.toLowerCase() === "k") v *= 1000;
    if (m[3]?.toLowerCase() === "m") v *= 1_000_000;
    out.push(v);
  }
  return out;
}

/** Words that mean the feature is present, and words that deny it ("no pool"). */
const FEATURE_WORDS: Record<Amenity, RegExp> = {
  pool: /\b(swimming\s+)?pool\b/i, air_conditioning: /\b(air[\s-]?con(ditioning)?|a\/c|reverse[\s-]cycle)\b/i, garage: /\bgarage\b/i,
  balcony: /\b(balcony|balconies)\b/i, garden: /\bgardens?\b/i, solar: /\bsolar\b/i, pet_friendly: /\bpet[\s-]friendly\b/i,
  furnished: /\b(fully\s+|part\s+)?furnished\b/i, ensuite: /\ben[\s-]?suite\b/i, study: /\b(study|home\s+office)\b/i, lift: /\b(lift|elevator)\b/i,
  security: /\b(security|alarm|intercom)\b/i
};
const negated = (text: string, re: RegExp): boolean => new RegExp(`\\b(?:no|without)\\s+(?:\\w+\\s+){0,2}${re.source}`, "i").test(text);
const FEATURE_PHOTO_CATEGORY: Partial<Record<Amenity, string>> = { pool: "pool", garage: "garage", garden: "outdoor" };

export function reviewListing(input: ElenaInput): ElenaReview {
  const { listing: l, photos, wordingFlags, clearedWording, gateReasons } = input;
  const base = `/listings/${l.id}`;
  const edit = (anchor: string) => `${base}/edit#${anchor}`;
  const findings: ElenaFinding[] = [];
  const add = (id: string, severity: FindingSeverity, area: FindingArea, message: string, fixHref: string) => findings.push({ id, severity, area, message, fixHref });
  const isHome = HOME_TYPES.includes(l.propertyType);
  const desc = (l.description ?? "").trim();

  // Required fields
  if (l.title.trim().length < 8) add("title", l.title.trim() ? "advice" : "block", "details", l.title.trim() ? "The title is very short. A clear title helps buyers find it." : "The listing needs a title.", edit("title"));
  if (!l.address.trim()) add("address", "block", "details", "The property address is missing.", edit("address"));
  if (!l.suburb?.trim()) add("suburb", "block", "details", "The suburb is missing, so buyers searching by area cannot find the listing.", edit("suburb"));
  if (!l.postcode?.trim()) add("postcode", "block", "details", "The postcode is missing.", edit("postcode"));
  if (l.priceCents === undefined || l.priceCents === null) add("price", "block", "details", l.transactionType === "rent" ? "The weekly rent is missing." : "The asking price is missing.", edit("price"));
  if (isHome && l.bedrooms === undefined) add("bedrooms", "block", "details", "The number of bedrooms is missing.", edit("bedrooms"));
  if (isHome && l.bathrooms === undefined) add("bathrooms", "block", "details", "The number of bathrooms is missing.", edit("bathrooms"));
  if (isHome && l.parking === undefined) add("parking", "advice", "details", "Parking spaces are not filled in. Enter 0 if there are none.", edit("parking"));

  // Description
  if (!desc) add("description", "block", "description", "The listing needs a description.", edit("description"));
  else if (checkRealText(desc)) add("description-gibberish", "block", "description", checkRealText(desc)!, edit("description"));
  else if (desc.length < DESCRIPTION_MIN) add("description-short", "advice", "description", `The description is short (${desc.length} characters). Buyers expect more about the home and the area.`, edit("description"));

  // Description against the form
  if (desc) {
    const mismatch = (id: string, label: string, found: number[], form: number | undefined) => {
      const wrong = [...new Set(found)].filter(n => form !== undefined && n !== form);
      if (wrong.length > 0) add(id, "block", "description", `The description says ${wrong.join(" and ")} ${label}, but the form says ${form}. Make them match.`, edit(id.replace("-mismatch", "")));
    };
    mismatch("bedrooms-mismatch", "bedrooms", countsIn(desc, "bed"), l.bedrooms);
    mismatch("bathrooms-mismatch", "bathrooms", countsIn(desc, "bath"), l.bathrooms);
    mismatch("parking-mismatch", "parking spaces", countsIn(desc, "car"), l.parking);
    if (l.priceCents !== undefined && l.priceCents !== null) {
      const dollars = l.priceCents / 100;
      // A figure within 30% of the price that is not the price is almost certainly a different price. Other figures (rates, strata) are left alone.
      const off = dollarAmountsIn(desc).filter(a => a !== dollars && a >= dollars * 0.7 && a <= dollars * 1.3);
      if (off.length > 0) add("price-mismatch", "block", "description", `The description mentions $${off[0]!.toLocaleString("en-AU")}, but the ${l.transactionType === "rent" ? "rent" : "asking price"} on the form is ${formatPrice(l.priceCents, l.transactionType)}.`, edit("price"));
    }
    const ticked = new Set(l.amenities ?? []);
    for (const a of AMENITIES) {
      const re = FEATURE_WORDS[a];
      if (!re.test(desc)) continue;
      const denied = negated(desc, re);
      if (denied && ticked.has(a)) add(`feature-${a}`, "block", "description", `${AMENITY_LABELS[a]} is ticked, but the description says the home does not have it.`, edit("amenities"));
      else if (!denied && !ticked.has(a) && !(a === "security" || a === "garden" || a === "study")) add(`feature-${a}`, "advice", "description", `The description mentions ${AMENITY_LABELS[a].toLowerCase()} but it is not ticked in the features list.`, edit("amenities"));
    }
  }

  // Photos
  const n = photos.photos.length;
  if (n === 0) add("photos-none", "block", "photos", "The listing has no photos. Buyers will not look at a listing without them.", `${base}/photos`);
  else {
    if (n < MIN_PHOTOS) add("photos-few", "advice", "photos", `Only ${n} ${n === 1 ? "photo" : "photos"}. Listings with ${MIN_PHOTOS} or more get far more enquiries.`, `${base}/photos`);
    const cover = photos.photos[0]!;
    if (cover.width < COVER_MIN_WIDTH) add("photos-cover", "advice", "photos", `The cover photo is small (${cover.width} px wide). Use one at least ${COVER_MIN_WIDTH} px wide.`, `${base}/photos`);
    const noAlt = photos.photos.filter(p => !p.alt.trim()).length;
    if (noAlt > 0) add("photos-alt", "advice", "photos", `${noAlt} ${noAlt === 1 ? "photo has" : "photos have"} no description for screen readers.`, `${base}/photos`);
    // Photo against description: only judged when the owner has filed photos under rooms.
    const cats = new Set(photos.photos.map(p => p.category).filter(Boolean));
    if (cats.size > 0 && desc) {
      for (const [a, cat] of Object.entries(FEATURE_PHOTO_CATEGORY) as [Amenity, string][]) {
        if (FEATURE_WORDS[a].test(desc) && !negated(desc, FEATURE_WORDS[a]) && !cats.has(cat)) add(`photo-${a}`, "advice", "photos", `The description mentions ${AMENITY_LABELS[a].toLowerCase()} but no photo is filed under it.`, `${base}/photos`);
      }
      if (l.bedrooms && !cats.has("bedroom")) add("photo-bedroom", "advice", "photos", "No photo is filed under bedrooms.", `${base}/photos`);
    }
  }

  // Site plan: required for land, recommended otherwise
  if (photos.floorplans === 0) {
    if (l.propertyType === "land") add("siteplan", "block", "siteplan", "Land listings need a site plan. Upload one in the photos page.", `${base}/photos`);
    else add("siteplan", "advice", "siteplan", "No floor plan or site plan is uploaded. Buyers compare layouts first.", `${base}/photos`);
  }

  // Wording filter
  for (const { field, flags } of wordingFlags) {
    for (const f of flags) {
      const cleared = clearedWording.has(flagKey(field, f.match));
      if (f.severity === "block" && cleared) continue;
      add(`wording-${field}-${f.ruleId}-${f.start}`, f.severity === "block" ? "block" : "advice", "wording",
        `"${f.match}" in the ${field}: ${f.message} ${f.suggestion}`.trim(), edit(field === "title" ? "title" : "description"));
    }
  }

  // Compliance, terms, fee and trust account come from the publish gate. Wording reasons are already covered above.
  for (const [i, r] of gateReasons.entries()) {
    if (r.startsWith("Wording in the ")) continue;
    const href = /disclosure|compliance/i.test(r) ? `${base}/disclosures`
      : /fee|plan has not been paid/i.test(r) ? `${base}/checkout`
      : /terms/i.test(r) ? "/terms"
      : /bond/i.test(r) ? edit("bond")
      : /price|rent/i.test(r) ? edit("price") : base;
    add(`gate-${i}`, "block", "compliance", r, href);
  }

  const order = (f: ElenaFinding) => (f.severity === "block" ? 0 : 1);
  findings.sort((a, b) => order(a) - order(b));
  const blockers = findings.filter(f => f.severity === "block").length;
  return { ready: blockers === 0, findings, blockers, advice: findings.length - blockers };
}
