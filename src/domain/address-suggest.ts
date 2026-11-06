/** Address suggestions for the listing form's street address field. Pure: no network, no env. */

export type AuState = "NSW" | "VIC" | "QLD" | "WA" | "SA" | "TAS" | "ACT" | "NT";

/** What the form fills in when a suggestion is picked. Any part the provider did not return is left out. */
export interface AddressParts { address: string; suburb?: string; state?: AuState; postcode?: string }

export interface AddressSuggestion {
  id: string;
  main: string;
  secondary: string;
  /** Present when the provider returned the parts with the suggestion; otherwise the client resolves `id` first. */
  parts?: AddressParts;
}

export type AddressProvider = "google" | "osm";

/** A map position inside Australia, rounded to 6 decimals (the precision the listing stores). */
export interface GeoPoint { lat: number; lng: number }

export interface AddressLookupPort {
  provider: AddressProvider;
  suggest(query: string, sessionToken: string): Promise<AddressSuggestion[]>;
  /** Parts for a suggestion that came without them. Null when the place is unknown or not in Australia. */
  resolve(id: string, sessionToken: string): Promise<AddressParts | null>;
  /** Map position for a full typed address. Null when nothing in Australia matches. */
  locate(address: string): Promise<GeoPoint | null>;
}

const AU_BOX = { south: -44, west: 112, north: -9, east: 154 };
/** A finite lat/lng pair inside Australia, rounded to 6 decimals. Null otherwise. */
export function auPoint(lat: unknown, lng: unknown): GeoPoint | null {
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < AU_BOX.south || lat > AU_BOX.north || lng < AU_BOX.west || lng > AU_BOX.east) return null;
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}

export const ADDRESS_QUERY_MIN = 3;
export const ADDRESS_QUERY_MAX = 120;
export const MAX_SUGGESTIONS = 6;

/** Trims and collapses spaces. Null when too short, too long or carrying control characters. */
export function normaliseAddressQuery(q: unknown): string | null {
  if (typeof q !== "string" || q.length > ADDRESS_QUERY_MAX * 2) return null;
  const s = q.replace(/\s+/g, " ").trim();
  if (s.length < ADDRESS_QUERY_MIN || s.length > ADDRESS_QUERY_MAX || /[\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

const SESSION_TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
/** The client's per-typing-session token (groups Google billing). A bad or missing one gets a fixed fallback. */
export const sessionTokenOr = (t: unknown, fallback: string): string => (typeof t === "string" && SESSION_TOKEN.test(t) ? t : fallback);

const PLACE_ID = /^[A-Za-z0-9_-]{4,300}$/;
export const isPlaceId = (id: unknown): id is string => typeof id === "string" && PLACE_ID.test(id);

const STATE_NAMES: Record<string, AuState> = {
  "new south wales": "NSW", nsw: "NSW", victoria: "VIC", vic: "VIC", queensland: "QLD", qld: "QLD",
  "western australia": "WA", wa: "WA", "south australia": "SA", sa: "SA", tasmania: "TAS", tas: "TAS",
  "australian capital territory": "ACT", act: "ACT", "northern territory": "NT", nt: "NT"
};

/** "Queensland" or "QLD" to "QLD". Undefined for anything else. */
export const toAuState = (s: unknown): AuState | undefined => (typeof s === "string" ? STATE_NAMES[s.trim().toLowerCase()] : undefined);

const POSTCODE = /^\d{4}$/;
const clean = (s: unknown, max: number): string | undefined => {
  if (typeof s !== "string") return undefined;
  const v = s.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
  return v === "" ? undefined : v;
};

/** "6 Gable St", "Bracken Ridge", "QLD", "4017" to "6 Gable St, Bracken Ridge QLD 4017", the format the form's placeholder shows. */
export function formatAddress(street: string, suburb?: string, state?: AuState, postcode?: string): string {
  const tail = [suburb, state, postcode].filter(Boolean).join(" ");
  return tail ? `${street}, ${tail}` : street;
}

/** Builds the parts from loose provider fields, dropping anything malformed. Null without a street line. */
export function addressParts(f: { street?: unknown; suburb?: unknown; state?: unknown; postcode?: unknown }): AddressParts | null {
  const street = clean(f.street, 200);
  if (!street) return null;
  const suburb = clean(f.suburb, 80);
  const state = toAuState(f.state);
  const pc = clean(f.postcode, 10);
  const postcode = pc && POSTCODE.test(pc) ? pc : undefined;
  return {
    address: formatAddress(street, suburb, state, postcode).slice(0, 300),
    ...(suburb ? { suburb } : {}), ...(state ? { state } : {}), ...(postcode ? { postcode } : {})
  };
}
