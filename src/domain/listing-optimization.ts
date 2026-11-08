import { formatPrice } from "./listing-details";
import { PHOTO_CATEGORIES, VARIANT_WIDTH } from "./listing-photos";

/**
 * Seller listing optimization (Elena). Pure and deterministic: it reads the facts of a listing (photo gallery, description, price,
 * details) and returns suggestions with a rough impact range. Elena's model is text-only, so photos are judged from what the gallery
 * records (count, size, rooms covered, captions), never from the picture itself. Impact ranges come from a fixed table and are
 * labelled as estimates. Nothing here changes a listing: the seller decides.
 */
export const OPTIMIZATION_NOTE =
  "Suggestions come from simple rules on your listing and recent sales. The impact ranges are rough guides, not promises. You decide what to change.";
export const IMPACT_BASIS = "Rule-of-thumb range, not measured on this site yet.";

export const SUGGESTION_TYPES = [
  "add_photos", "photo_gaps", "photo_resolution", "add_floorplan", "photo_captions", "expand_description", "highlight_features", "complete_details", "lower_price"
] as const;
export type SuggestionType = (typeof SUGGESTION_TYPES)[number];
export const isSuggestionType = (v: unknown): v is SuggestionType => typeof v === "string" && (SUGGESTION_TYPES as readonly string[]).includes(v);
export const SUGGESTION_STATUSES = ["open", "implemented", "dismissed", "outdated"] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];
/** What a seller may set. "outdated" is set only by the system when the issue is no longer found. */
export const SELLER_STATUSES = ["open", "implemented", "dismissed"] as const;
export const isSellerStatus = (v: unknown): v is (typeof SELLER_STATUSES)[number] => typeof v === "string" && (SELLER_STATUSES as readonly string[]).includes(v);

export const TYPE_LABEL: Record<SuggestionType, string> = {
  add_photos: "Add photos", photo_gaps: "Cover missing rooms", photo_resolution: "Use larger photos", add_floorplan: "Add a floorplan", photo_captions: "Caption your photos",
  expand_description: "Write more in the description", highlight_features: "Highlight your features", complete_details: "Complete the listing details", lower_price: "Lower the price"
};

export const MIN_COMPS_FOR_PRICE = 3;
/** Asking price must be this far above the balanced figure before a cut is suggested. */
export const PRICE_GAP_TRIGGER = 0.03;

export interface Range { low: number; high: number }
export interface Impact { viewsPercent: Range; offersPercent: Range; basis: string }
export interface OptimizationSettings { enabled: boolean; minPhotos: number; minDescriptionWords: number; maxPriceCutPercent: number; disabledTypes: SuggestionType[] }
export const DEFAULT_OPTIMIZATION_SETTINGS: OptimizationSettings = { enabled: false, minPhotos: 8, minDescriptionWords: 60, maxPriceCutPercent: 10, disabledTypes: [] };

/** Fixed table: typical lift in views and in offers when the suggestion is followed. */
const IMPACT: Record<Exclude<SuggestionType, "lower_price">, { v: [number, number]; o: [number, number] }> = {
  add_photos: { v: [15, 30], o: [5, 12] }, photo_gaps: { v: [8, 15], o: [3, 8] }, photo_resolution: { v: [5, 10], o: [2, 5] }, add_floorplan: { v: [5, 12], o: [3, 7] },
  photo_captions: { v: [2, 5], o: [1, 3] }, expand_description: { v: [5, 10], o: [2, 6] }, highlight_features: { v: [4, 9], o: [2, 5] }, complete_details: { v: [3, 8], o: [2, 5] }
};
const impact = (t: Exclude<SuggestionType, "lower_price">): Impact => ({ viewsPercent: { low: IMPACT[t].v[0], high: IMPACT[t].v[1] }, offersPercent: { low: IMPACT[t].o[0], high: IMPACT[t].o[1] }, basis: IMPACT_BASIS });

export interface PhotoFacts {
  /** Visible photos only (hidden ones do not count). Floorplans and 360 photos are counted separately. */
  visibleCount: number; floorplans: number; lowResCount: number;
  /** Visible photos filed under each room key; "" is not sorted yet. */
  categories: Record<string, number>; captioned: number; hasTour: boolean;
}
export interface ListingFacts {
  transactionType: "sale" | "rent"; propertyType: string; description?: string | undefined; priceCents?: number | undefined;
  bedrooms?: number | undefined; bathrooms?: number | undefined; parking?: number | undefined; suburb?: string | undefined; postcode?: string | undefined;
  amenities: readonly string[]; photos: PhotoFacts;
}
export interface PriceFacts { medianCents: number; balancedCents: number; sample: number; trend?: "up" | "down" | "flat" | undefined }

export interface Suggestion { type: SuggestionType; title: string; description: string; impact: Impact; priority: number }

const RESIDENTIAL = new Set(["house", "unit", "townhouse"]);
const wordsOf = (t: string | undefined) => (t ?? "").trim().split(/\s+/).filter(Boolean);
const ROOM = Object.fromEntries(PHOTO_CATEGORIES.map(c => [c.key, c.label])) as Record<string, string>;

/** What a description should mention for each ticked feature. */
const AMENITY_WORDS: Record<string, RegExp> = {
  pool: /\bpool\b/i, air_conditioning: /air[\s-]?con|a\/c|cooling|reverse cycle/i, garage: /garage|car\s?port|off[\s-]street/i, balcony: /balcon|deck|terrace|patio/i,
  garden: /garden|yard|lawn/i, solar: /solar/i, pet_friendly: /\bpets?\b/i, furnished: /furnish/i, ensuite: /ensuite|en-suite/i, study: /study|home office/i, lift: /\blift\b|elevator/i, security: /secur|alarm|intercom/i
};
const AMENITY_NAME: Record<string, string> = {
  pool: "the pool", air_conditioning: "air conditioning", garage: "the garage", balcony: "the balcony or deck", garden: "the garden", solar: "solar panels",
  pet_friendly: "that pets are welcome", furnished: "that it is furnished", ensuite: "the ensuite", study: "the study", lift: "the lift", security: "the security"
};
/** Rooms a buyer expects to see. Outdoor areas are expected when the owner ticked them. */
function expectedRooms(f: ListingFacts): string[] {
  if (!RESIDENTIAL.has(f.propertyType)) return ["exterior"];
  const r = ["exterior", "living", "kitchen", "bedroom", "bathroom"];
  if (f.amenities.includes("pool")) r.push("pool");
  if (f.amenities.includes("garden") || f.amenities.includes("balcony")) r.push("outdoor");
  return r;
}
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const money = (c: number) => formatPrice(c, "sale");

export function generateSuggestions(f: ListingFacts, price: PriceFacts | undefined, s: OptimizationSettings): Suggestion[] {
  const out: Omit<Suggestion, "priority">[] = [];
  const add = (type: Exclude<SuggestionType, "lower_price">, description: string) => out.push({ type, title: TYPE_LABEL[type], description, impact: impact(type) });
  const p = f.photos;

  if (p.visibleCount < s.minPhotos) {
    add("add_photos", p.visibleCount === 0 ? `Your listing has no photos. Listings with at least ${s.minPhotos} photos get far more attention.`
      : `Your listing shows ${p.visibleCount} photo${p.visibleCount === 1 ? "" : "s"}. Aim for at least ${s.minPhotos}, covering every main room and the outside.`);
  }
  if (p.visibleCount > 0) {
    const sorted = Object.entries(p.categories).some(([k, n]) => k !== "" && n > 0);
    if (!sorted) add("photo_gaps", "Your photos are not sorted by room, so we cannot check that every room is covered. Pick a room for each photo in the gallery.");
    else {
      const missing = expectedRooms(f).filter(k => !((p.categories[k] ?? 0) > 0)).map(k => (ROOM[k] ?? k).toLowerCase());
      if (missing.length) add("photo_gaps", `Buyers expect to see ${list(missing)}. Add a photo for each.`);
    }
    if (p.lowResCount > 0) add("photo_resolution", `${p.lowResCount} photo${p.lowResCount === 1 ? " is" : "s are"} narrower than ${VARIANT_WIDTH.medium} pixels and may look blurry on large screens. Upload larger originals.`);
    if (p.captioned < Math.ceil(p.visibleCount / 2)) add("photo_captions", "Most photos have no caption. A short caption naming the room and a feature helps buyers and search. Elena can suggest captions in the gallery.");
  }
  if (RESIDENTIAL.has(f.propertyType) && p.floorplans === 0) add("add_floorplan", "A floorplan helps buyers picture the layout and cuts down on questions.");

  const words = wordsOf(f.description).length;
  if (words < s.minDescriptionWords) {
    add("expand_description", words === 0 ? "Your listing has no description. Say what makes the home special, the layout, the area and what is nearby."
      : `Your description is ${words} word${words === 1 ? "" : "s"}. Aim for at least ${s.minDescriptionWords}: the layout, recent updates, the neighbourhood and what is nearby.`);
  }
  const text = f.description ?? "";
  const unmentioned = f.amenities.filter(a => AMENITY_WORDS[a] && !AMENITY_WORDS[a]!.test(text)).map(a => AMENITY_NAME[a] ?? a);
  if (unmentioned.length) add("highlight_features", `You ticked features the description does not mention. Say something about ${list(unmentioned)}.`);

  const missingDetails: string[] = [];
  if (RESIDENTIAL.has(f.propertyType)) {
    if (f.bedrooms === undefined) missingDetails.push("bedrooms");
    if (f.bathrooms === undefined) missingDetails.push("bathrooms");
    if (f.parking === undefined) missingDetails.push("parking");
  }
  if (!f.suburb && !f.postcode) missingDetails.push("suburb");
  if (f.priceCents === undefined) missingDetails.push("price");
  if (missingDetails.length) add("complete_details", `Add the ${list(missingDetails)}. Searches and filters skip listings that leave these out.`);

  if (f.transactionType === "sale" && f.priceCents && price && price.sample >= MIN_COMPS_FOR_PRICE && f.priceCents > price.balancedCents * (1 + PRICE_GAP_TRIGGER)) {
    const floor = Math.round(f.priceCents * (1 - s.maxPriceCutPercent / 100));
    const target = Math.max(price.balancedCents, floor);
    const cut = Math.round(((f.priceCents - target) / f.priceCents) * 1000) / 10;
    if (cut >= 1) {
      const capped = target > price.balancedCents;
      out.push({
        type: "lower_price", title: TYPE_LABEL.lower_price, impact: {
          viewsPercent: { low: Math.round(cut * 2), high: Math.round(cut * 4) }, offersPercent: { low: Math.round(cut * 3), high: Math.round(cut * 6) }, basis: IMPACT_BASIS
        },
        description: `Consider lowering the asking price by about ${cut}% to ${money(target)}. Similar homes sold for around ${money(price.medianCents)} (${price.sample} sales in the last 90 days)${price.trend === "down" ? ", and prices in your area are drifting down" : ""}.${capped ? ` This is capped at ${s.maxPriceCutPercent}% in one step.` : ""}`
      });
    }
  }

  return out.filter(x => !s.disabledTypes.includes(x.type)).map(x => ({ ...x, priority: x.impact.offersPercent.low + x.impact.offersPercent.high + x.impact.viewsPercent.high / 10 }))
    .sort((a, b) => b.priority - a.priority || a.type.localeCompare(b.type));
}

/** Settings from a staff request: whole numbers in range, booleans as booleans, known suggestion types only. */
export function parseOptimizationSettings(body: Record<string, unknown>, cur: OptimizationSettings): { ok: true; value: OptimizationSettings } | { ok: false; error: string } {
  const int = (k: string, c: number, lo: number, hi: number) => (body[k] === undefined ? c : typeof body[k] === "number" && Number.isInteger(body[k]) && (body[k] as number) >= lo && (body[k] as number) <= hi ? (body[k] as number) : null);
  const enabled = body["enabled"] === undefined ? cur.enabled : typeof body["enabled"] === "boolean" ? body["enabled"] : null;
  const minPhotos = int("minPhotos", cur.minPhotos, 3, 40), minDescriptionWords = int("minDescriptionWords", cur.minDescriptionWords, 20, 300), maxPriceCutPercent = int("maxPriceCutPercent", cur.maxPriceCutPercent, 1, 20);
  if (enabled === null) return { ok: false, error: "enabled must be true or false." };
  if (minPhotos === null) return { ok: false, error: "The minimum number of photos must be a whole number from 3 to 40." };
  if (minDescriptionWords === null) return { ok: false, error: "The minimum description length must be a whole number of words from 20 to 300." };
  if (maxPriceCutPercent === null) return { ok: false, error: "The largest price cut must be a whole number from 1 to 20 percent." };
  let disabledTypes = cur.disabledTypes;
  if (body["disabledTypes"] !== undefined) {
    const d = body["disabledTypes"];
    if (!Array.isArray(d) || !d.every(isSuggestionType)) return { ok: false, error: "disabledTypes must be a list of known suggestion types." };
    disabledTypes = SUGGESTION_TYPES.filter(t => d.includes(t));
  }
  return { ok: true, value: { enabled, minPhotos, minDescriptionWords, maxPriceCutPercent, disabledTypes } };
}
