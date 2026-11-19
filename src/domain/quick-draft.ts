import type { AiEnginePort } from "./ai-engine";
import { CONTACT_RE, isEngineUsable } from "./ai-engine";
import { checkSuggestion } from "./ai-description";
import { AMENITIES, type Amenity } from "./listing-details";
import { buildQuickSetup, summarise, type QuickSetup } from "./quick-setup";
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
export type QuickDraft = Extract<QuickSetup, { state: "ready" }> & { seen: string[]; photoState: PhotoState; photosRead: number; area: AreaInfo };
export type QuickDraftResult = QuickDraft | Extract<QuickSetup, { state: "unavailable" }>;

const FEATURE_WORDS: [RegExp, Amenity][] = [
  [/\bpool\b/i, "pool"], [/\b(air.?condition|split.?system|ducted (?:cooling|air))/i, "air_conditioning"], [/\b(garage|carport)\b/i, "garage"],
  [/\bbalcon/i, "balcony"], [/\b(garden|lawn|backyard|yard)\b/i, "garden"], [/\bsolar\b/i, "solar"], [/\bensuite\b/i, "ensuite"],
  [/\b(study|home office)\b/i, "study"], [/\blift\b/i, "lift"]
];

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

/** Never throws. Photos that cannot be read are skipped; with no vision model the draft is written from the address, notes and area facts alone. */
export async function buildQuickDraft(engine: AiEnginePort, input: DraftInput, photos: readonly { name: string; mimeType: string; bytes: Uint8Array }[], area: AreaInfo): Promise<QuickDraftResult> {
  const perPhoto: string[][] = [];
  let photoState: PhotoState = photos.length === 0 ? "none" : "off";
  if (photos.length > 0 && isEngineUsable(engine)) {
    for (const p of photos.slice(0, MAX_DRAFT_PHOTOS)) {
      try { perPhoto.push([...(await engine.describePhoto(p))]); } catch { /* skip this photo */ }
    }
    photoState = perPhoto.length > 0 ? "read" : "failed";
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
  return { ...r, ...summarise(f), fields: f, seen, photoState, photosRead: perPhoto.length, area };
}
