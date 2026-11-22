import type { AiEnginePort } from "./ai-engine";
import { CONTACT_RE, isEngineUsable } from "./ai-engine";
import { checkSuggestion } from "./ai-description";
import { AMENITIES, AMENITY_LABELS, formatAud, type Amenity } from "./listing-details";
import { buildQuickSetup, ruleTitle, summarise, type QuickFields, type QuickSetup } from "./quick-setup";
import { MAX_QUICK_NOTES } from "./quick-setup-limits";
import { QLD_DRAFT_VERSIONS } from "../config/disclosures";
import { STATE_DRAFT_VERSIONS } from "../config/disclosures-states";

/**
 * Elena's "write it from photos and address". The owner gives an address (and optionally photos and notes); Elena looks at the photos with the
 * self-hosted vision model, adds what the site already holds for the suburb and state, and writes a draft listing for the owner to review.
 * What she cannot see or find stays blank. Numbers (price, rooms) come only from the owner; photos only add features and what she saw.
 */
export const MAX_DRAFT_PHOTOS = 6;

export interface DraftInput {
  address: string; suburb?: string; state?: string; postcode?: string;
  notes?: string; transactionType?: "sale" | "rent";
  bedrooms?: number; bathrooms?: number; parking?: number; priceDollars?: number;
}
export interface SuburbFactLine { label: string; value: string }
export interface AreaInfo { suburbFacts: SuburbFactLine[]; suburbSource?: string; checklist: string[] }
export type PhotoState = "none" | "read" | "off" | "failed";
export type QuickDraft = Extract<QuickSetup, { state: "ready" }> & { seen: string[]; photoState: PhotoState; photosRead: number; area: AreaInfo; /** Questions for the owner about details Elena does not have. */ questions: string[]; /** Where each part of the draft came from, so the owner can see what was read from photos and what is rules and area data. */ provenance: { description: "ai" | "rules"; photos: PhotoState; area: boolean } };
export type QuickDraftResult = QuickDraft | Extract<QuickSetup, { state: "unavailable" }>;

const FEATURE_WORDS: [RegExp, Amenity][] = [
  [/\bpool\b/i, "pool"], [/\b(air.?condition|split.?system|ducted (?:cooling|air))/i, "air_conditioning"], [/\b(garage|carport)\b/i, "garage"],
  [/\bbalcon/i, "balcony"], [/\b(garden|lawn|backyard|yard)\b/i, "garden"], [/\bsolar\b/i, "solar"], [/\bensuite\b/i, "ensuite"],
  [/\b(study|home office)\b/i, "study"], [/\blift\b/i, "lift"]
];

const NAME_WORDS: [RegExp, string][] = [
  [/kitchen/i, "kitchen"], [/bath|ensuite/i, "bathroom"], [/bed(room)?s?\b|master/i, "bedroom"], [/living|lounge|family/i, "living room"],
  [/dining/i, "dining area"], [/garage|carport/i, "garage"], [/pool/i, "pool"], [/garden|yard|lawn/i, "garden"], [/balcon|deck|patio|alfresco/i, "outdoor area"],
  [/front|exterior|facade|street/i, "exterior"], [/study|office/i, "study"], [/laundry/i, "laundry"]
];
/** Offline photo reading: room words in the file names the owner chose ("kitchen.jpg"). Nothing is guessed from the pixels. */
export function observationsFromNames(names: readonly string[]): string[] {
  return names.map(n => NAME_WORDS.filter(([re]) => re.test(n)).map(([, w]) => w)).filter(w => w.length > 0).map(w => w.join(", "));
}

/** Keeps only plain observations (no contact details, no absolute claims), de-duplicated, and works out which known features they show. */
export function readObservations(perPhoto: readonly (readonly string[])[]): { seen: string[]; amenities: Amenity[] } {
  const seen: string[] = [];
  const keys = new Set<string>();
  for (const photo of perPhoto) for (const raw of photo) {
    const line = raw.replace(/\s+/g, " ").replace(/[.;]+$/, "").trim();
    const k = line.toLowerCase();
    if (line.length < 3 || keys.has(k) || CONTACT_RE.test(line) || !checkSuggestion(line)) continue;
    keys.add(k); seen.push(line);
  }
  const amenities = FEATURE_WORDS.filter(([re]) => seen.some(l => re.test(l))).map(([, a]) => a).filter(a => (AMENITIES as readonly string[]).includes(a));
  return { seen: seen.slice(0, 24), amenities };
}

/** The statutory items our drafts list for this state (sale, residential). Labels only; counsel confirms them before they bind anyone. */
export function stateChecklist(state: string | undefined): string[] {
  if (!state) return [];
  const v = [...QLD_DRAFT_VERSIONS, ...STATE_DRAFT_VERSIONS].find(x => x.jurisdiction === state && x.transactionType === "sale" && x.useClass === "residential");
  return v ? v.items.map(i => i.label) : [];
}

export function draftNotes(i: DraftInput, seen: readonly string[]): string {
  const place = [i.address, i.suburb, i.state, i.postcode].filter(Boolean).join(" ");
  const facts = [
    i.bedrooms !== undefined ? `${i.bedrooms} bedrooms` : "", i.bathrooms !== undefined ? `${i.bathrooms} bathrooms` : "", i.parking !== undefined ? `${i.parking} car spaces` : "",
    i.priceDollars !== undefined ? (i.transactionType === "rent" ? `$${i.priceDollars} per week` : `Asking $${i.priceDollars.toLocaleString("en-AU")}`) : ""
  ].filter(Boolean).join(", ");
  return [`Property at ${place}.`, facts && `${facts}.`, i.notes?.trim(), seen.length > 0 ? `Seen in the photos: ${seen.join(", ")}.` : ""].filter(Boolean).join(" ").slice(0, MAX_QUICK_NOTES);
}

const list = (xs: readonly string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sentence = (t: string) => { const x = t.replace(/\s+/g, " ").trim(); return x === "" ? "" : `${x.charAt(0).toUpperCase()}${x.slice(1)}${/[.!?]$/.test(x) ? "" : "."}`; };

/** Buyer-friendly sentences built only from facts the owner gave, what the photo names show and the area facts. Nothing is invented. */
export function ruleDescription(f: QuickFields, area: AreaInfo, seen: readonly string[], notes?: string): string {
  const rent = f.transactionType === "rent";
  const where = [f.suburb, f.jurisdiction].filter(Boolean).join(", ");
  const kind = f.propertyType === "unit" ? "unit" : f.propertyType;
  const parts: string[] = [];
  parts.push(sentence(`${/^[aeiou]/i.test(kind) ? "an" : "a"} ${kind}${where ? ` in ${where}` : ""} is now ${rent ? "available to rent" : "for sale"}`));
  const layout = [f.bedrooms !== undefined ? count(f.bedrooms, "bedroom") : "", f.bathrooms !== undefined ? count(f.bathrooms, "bathroom") : "", f.parking !== undefined ? (f.parking === 0 ? "no car space" : `parking for ${count(f.parking, "car")}`) : ""].filter(Boolean);
  if (layout.length) parts.push(sentence(`The ${kind} has ${list(layout)}`));
  if (f.amenities.length) parts.push(sentence(`Features: ${list(f.amenities.map(a => AMENITY_LABELS[a].toLowerCase()))}`));
  const rooms = [...new Set(seen.slice(0, 8))];
  if (rooms.length) parts.push(sentence(`The photos show ${list(rooms.map(r => (/^(a|an|the)\b/i.test(r) ? r : `the ${r}`)))}`));
  if (notes?.trim()) parts.push(sentence(notes.trim().slice(0, 600)));
  if (area.suburbFacts.length) parts.push(sentence(`In ${f.suburb ?? "the area"}, ${list(area.suburbFacts.slice(0, 3).map(x => `the ${x.label.toLowerCase()} is ${x.value}`))}${area.suburbSource ? ` (${area.suburbSource})` : ""}`));
  if (f.priceCents !== undefined) parts.push(sentence(rent ? `The rent is ${formatAud(f.priceCents)} per week` : `The asking price is ${formatAud(f.priceCents)}`));
  parts.push("Message the owner through this site to arrange an inspection or to make an offer.");
  return parts.join(" ");
}

/** What a good ad needs that we do not have yet, phrased as questions. */
export function draftQuestions(f: QuickFields, seen: readonly string[], notes?: string, photos: PhotoState = "none"): string[] {
  const q: string[] = [];
  if (photos !== "read") q.push("Which features do your photos show (pool, garden, air conditioning, solar, study)? Tick them in the form below.");
  const built = ["house", "unit", "townhouse"].includes(f.propertyType);
  if (built && f.bedrooms === undefined) q.push("How many bedrooms does it have?");
  if (built && f.bathrooms === undefined) q.push("How many bathrooms?");
  if (built && f.parking === undefined) q.push("How many car spaces?");
  if (f.priceCents === undefined) q.push(f.transactionType === "rent" ? "What is the weekly rent?" : "What is your asking price?");
  if (f.amenities.length === 0 && seen.length === 0) q.push("What features stand out (pool, air conditioning, solar, garden, study)?");
  if (!notes?.trim()) q.push("What is its condition, and has anything been renovated or updated recently?");
  q.push("What is nearby that buyers would care about (transport, schools, shops, parks)?");
  return q;
}

/** Never throws. Photos that cannot be read are skipped; with no vision model the draft is written from the address, notes and area facts alone. */
export async function buildQuickDraft(engine: AiEnginePort, input: DraftInput, photos: readonly { name: string; mimeType: string; bytes: Uint8Array }[], area: AreaInfo): Promise<QuickDraftResult> {
  const perPhoto: string[][] = [];
  let photoState: PhotoState = photos.length === 0 ? "none" : "off";
  if (photos.length > 0) {
    // Offline path first: room words in the file names. A vision model (when one is switched on) adds to it.
    const fromNames = observationsFromNames(photos.map(p => p.name));
    if (fromNames.length > 0) perPhoto.push(fromNames);
  }
  if (photos.length > 0 && isEngineUsable(engine)) {
    for (const p of photos.slice(0, MAX_DRAFT_PHOTOS)) {
      try { perPhoto.push([...(await engine.describePhoto(p))]); } catch { /* skip this photo */ }
    }
    photoState = perPhoto.length > 0 ? "read" : "failed";
  } else if (photos.length > 0) {
    photoState = perPhoto.length > 0 ? "read" : "off";
  }
  const { seen, amenities } = readObservations(perPhoto);
  const r = await buildQuickSetup(engine, draftNotes(input, seen), input.transactionType);
  if (r.state !== "ready") return r;
  const f = r.fields;
  // The owner's own entries always win over anything read from free text.
  if (input.address) f.address = input.address;
  if (input.suburb) f.suburb = input.suburb;
  if (input.state) f.jurisdiction = input.state;
  if (input.postcode) f.postcode = input.postcode;
  if (input.bedrooms !== undefined) f.bedrooms = input.bedrooms;
  if (input.bathrooms !== undefined) f.bathrooms = input.bathrooms;
  if (input.parking !== undefined) f.parking = input.parking;
  if (input.priceDollars !== undefined) f.priceCents = Math.round(input.priceDollars * 100);
  f.amenities = [...new Set([...f.amenities, ...amenities])];
  // A "3/9 Beach Pde" style address is a unit unless the owner's words said otherwise.
  if (r.source === "rules" && f.propertyType === "house" && /^\s*(unit\s*)?\d+[a-z]?\s*\/\s*\d+/i.test(input.address) && !/\b(house|home|villa|cottage)\b/i.test(input.notes ?? "")) f.propertyType = "unit";
  const questions = draftQuestions(f, seen, input.notes, photoState);
  // Without the AI the rules writer still writes a full, factual ad and a proper title, so the owner edits instead of starting blank.
  if (r.source === "rules") { f.description = ruleDescription(f, area, seen, input.notes); f.title = ruleTitle(f); }
  return { ...r, ...summarise(f), fields: f, seen, photoState, photosRead: perPhoto.length, area, questions, provenance: { description: r.source, photos: photoState, area: area.suburbFacts.length > 0 } };
}
