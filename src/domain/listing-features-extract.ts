import { AMENITIES, type Amenity } from "./listing-details";

/** Facts read from a free-text description. Pure and client-safe (no node imports). */
export interface ExtractedFeatures { bedrooms?: number; bathrooms?: number; parking?: number; amenities: Amenity[] }

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, single: 1, double: 2, triple: 3 };
const NUM = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|single|double|triple)";
const toNum = (s: string): number => WORDS[s.toLowerCase()] ?? Number(s);
const first = (text: string, re: RegExp): number | undefined => {
  const m = re.exec(text);
  if (!m?.[1]) return undefined;
  const n = toNum(m[1]);
  return Number.isFinite(n) && n >= 0 && n <= 20 ? n : undefined;
};
const sum = (text: string, re: RegExp): number | undefined => {
  let total = 0, found = false;
  for (const m of text.matchAll(re)) { const n = toNum(m[1] ?? ""); if (Number.isFinite(n) && n <= 20) { total += n; found = true; } }
  return found && total <= 20 ? total : undefined;
};

const AMENITY_PATTERNS: Record<Amenity, RegExp> = {
  pool: /\b(swimming\s+)?pool\b/i,
  air_conditioning: /\b(air[\s-]?con(ditioning|ditioned)?|a\/c|split[\s-]system|ducted\s+(cooling|air))\b/i,
  garage: /\bgarages?\b/i,
  balcony: /\b(balcony|balconies|terrace)\b/i,
  garden: /\b(garden|gardens|backyard|back\s+yard)\b/i,
  solar: /\bsolar\b/i,
  pet_friendly: /\b(pet[\s-]?friendly|pets?\s+(allowed|welcome|considered|negotiable))\b/i,
  furnished: /(?<!\bun)\bfurnished\b/i,
  ensuite: /\ben[\s-]?suites?\b/i,
  study: /\b(study|home\s+office)\b/i,
  lift: /\b(lift|elevator)\b/i,
  security: /\b(security|alarm|intercom|cctv)\b/i
};

/** "4 bedroom", "4 bed", "3 toilet", "6 garage", "2 car spaces" and the extras list. Returns only what the text states. */
export function extractFeatures(text: string): ExtractedFeatures {
  const t = text.slice(0, 5000);
  const out: ExtractedFeatures = { amenities: AMENITIES.filter(a => AMENITY_PATTERNS[a].test(t)) };
  const bedrooms = first(t, new RegExp(`\\b${NUM}[\\s-]*(?:bed(?:room)?s?|br)\\b`, "i"));
  const bathrooms = sum(t, new RegExp(`\\b${NUM}[\\s-]*(?:bath(?:room)?s?|toilets?|wc)\\b`, "gi"));
  const parking = first(t, new RegExp(`\\b${NUM}[\\s-]*(?:car[\\s-]*(?:spaces?|parks?|ports?|garages?|bays?|spots?)|garages?|carports?|parking(?:\\s+spaces?)?)\\b`, "i"));
  if (bedrooms !== undefined) out.bedrooms = bedrooms;
  if (bathrooms !== undefined) out.bathrooms = bathrooms;
  if (parking !== undefined) {
    out.parking = parking;
    if (/garage/i.test(t) && !out.amenities.includes("garage")) out.amenities.push("garage");
  }
  return out;
}

export interface FeatureMismatch { field: "bedrooms" | "bathrooms" | "parking" | "amenity"; message: string; value?: number; amenity?: Amenity }
export interface FeatureValues { bedrooms: string; bathrooms: string; parking: string; amenities: readonly string[] }

/** Compares what the description says with what is in the boxes. Never changes anything: the owner decides. */
export function featureMismatches(text: string, cur: FeatureValues): FeatureMismatch[] {
  const f = extractFeatures(text);
  const out: FeatureMismatch[] = [];
  const names = { bedrooms: "bedrooms", bathrooms: "bathrooms (toilets count)", parking: "parking spaces" } as const;
  for (const k of ["bedrooms", "bathrooms", "parking"] as const) {
    const v = f[k];
    if (v === undefined) continue;
    const have = cur[k].trim();
    if (have !== String(v)) out.push({ field: k, value: v, message: `Your description says ${v} ${names[k]} but the box ${have === "" ? "is empty" : `says ${have}`}.` });
  }
  for (const a of f.amenities) {
    if (!cur.amenities.includes(a)) out.push({ field: "amenity", amenity: a, message: `Your description mentions "${a.replace("_", " ")}" but it is not ticked.` });
  }
  const beds = [...text.matchAll(new RegExp(`\\b${NUM}[\\s-]*(?:bed(?:room)?s?|br)\\b`, "gi"))].map(m => toNum(m[1] ?? ""));
  if (new Set(beds).size > 1) out.push({ field: "bedrooms", message: `Your description gives different bedroom counts (${[...new Set(beds)].join(" and ")}). Please make them agree.` });
  return out;
}
