/**
 * Elena's page awareness. Pure and client-safe (no imports): maps a URL path and a form field to a readable page and section,
 * gives the hint Elena shows for that section, and reads room counts from the owner's own words.
 * PRIVACY: where a person is on the site is kept in the browser tab's memory only. It is never sent to the server or stored.
 */
export interface ElenaPlace { path: string; pageLabel: string; section: string; sectionLabel: string; field: string }

const PAGES: [RegExp, string][] = [
  [/^\/$/, "Home"], [/^\/listings\/new$/, "Create a listing"], [/^\/listings\/mine$/, "My listings"], [/^\/listings\/[^/]+\/edit$/, "Edit listing"],
  [/^\/listings\/[^/]+/, "Listing"], [/^\/listings$/, "Browse listings"], [/^\/messages/, "Messages"], [/^\/enquiries/, "Enquiries"],
  [/^\/offers/, "Offers"], [/^\/plans/, "Plans and fees"], [/^\/dashboard/, "Dashboard"], [/^\/settings/, "Settings"], [/^\/billing/, "Billing"],
  [/^\/inspections/, "Inspections"], [/^\/settlements/, "Settlement"], [/^\/market/, "Market"], [/^\/buyer/, "Buyer area"], [/^\/agent/, "Agent area"],
  [/^\/notifications/, "Notifications"]
];

export function pageLabel(path: string): string {
  const p = path.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";
  for (const [re, label] of PAGES) if (re.test(p)) return label;
  return "this page";
}

export const isListingForm = (path: string) => /^\/listings\/new\/?$/.test(path) || /^\/listings\/[^/]+\/edit\/?$/.test(path);

export const LISTING_SECTIONS = {
  basics: "The basics", type: "What you are listing", location: "Location", price: "Price", description: "Description", features: "Features", photos: "Photos"
} as const;
export type ListingSection = keyof typeof LISTING_SECTIONS;

const FIELD_SECTION: Record<string, ListingSection> = {
  title: "basics", address: "basics", transactionType: "type", useClass: "type", propertyType: "type", jurisdiction: "type",
  suburb: "location", postcode: "location", price: "price", description: "description", bedrooms: "features", bathrooms: "features", parking: "features", amenities: "features"
};

/** The listing-form section a field belongs to, or undefined for any other field. */
export const sectionOfField = (name: string): ListingSection | undefined => FIELD_SECTION[name];

export interface SectionHint { text: string; action?: { id: "pricing" | "rewrite" | "shots" | "tell"; label: string } }

/** What Elena says about a section of the listing form, given which fields are still empty. */
export function sectionHint(section: string, empty: { price: boolean; description: boolean; rooms: boolean }): SectionHint | undefined {
  switch (section) {
    case "basics": return { text: "A clear title and the exact street address help buyers find it. Start typing the street and I suggest the address." };
    case "type": return { text: "Choose sale or rent first. It changes my price guidance and the questions I ask." };
    case "location": return { text: "Buyers search by suburb, and I use it to find recent nearby results." };
    case "price": return empty.price
      ? { text: "Not sure what to ask? I can show a range from recent nearby results.", action: { id: "pricing", label: "Show price guidance" } }
      : { text: "I compare your price with recent nearby results. You decide the number.", action: { id: "pricing", label: "Check my price" } };
    case "description": return empty.description
      ? { text: "Tell me about the property in your own words and I will fill in the details.", action: { id: "tell", label: "Tell Elena" } }
      : { text: "I can tidy the wording or make it shorter. You keep control of every change.", action: { id: "rewrite", label: "Make it better" } };
    case "features": return empty.rooms
      ? { text: "Bedrooms, bathrooms and parking are the first filters buyers use. Tell me and I fill them in.", action: { id: "tell", label: "Tell Elena" } }
      : { text: "Tick only what is true. I suggest extras I find in your description." };
    case "photos": return { text: "About 10 bright, landscape photos work best. I have a shot list.", action: { id: "shots", label: "Open shot list" } };
    default: return undefined;
  }
}

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
const NUM = "(\\d{1,2}|one|two|three|four|five|six|seven|eight)";
const toNum = (s: string) => (/^\d+$/.test(s) ? Number(s) : WORDS[s.toLowerCase()]);

/** Room counts the owner wrote ("3 bed, 2 bath, 2 car"). Only their own numbers are read, never guessed. */
export function roomsFromText(text: string): { bedrooms?: number; bathrooms?: number; parking?: number } {
  const t = text.replace(/\s+/g, " ");
  const pick = (re: RegExp) => { const m = re.exec(t); const n = m ? toNum(m[1]!) : undefined; return n !== undefined && n <= 20 ? n : undefined; };
  const out: { bedrooms?: number; bathrooms?: number; parking?: number } = {};
  const b = pick(new RegExp(`\\b${NUM}[ -]?(?:bed(?:room)?s?|br|bdrm?s?)\\b`, "i"));
  const ba = pick(new RegExp(`\\b${NUM}[ -]?(?:bath(?:room)?s?)\\b`, "i"));
  const p = pick(new RegExp(`\\b${NUM}[ -]?(?:car(?: ?(?:spaces?|garage|park|port))?s?|garages?|carports?|parking)\\b`, "i"));
  if (b !== undefined) out.bedrooms = b;
  if (ba !== undefined) out.bathrooms = ba;
  if (p !== undefined) out.parking = p;
  return out;
}
