import { AU_BOUNDS, maxPriceCents } from "./listing-details";
import { child, parseXml, textOf, XmlError, type XmlNode } from "./xml-lite";

/**
 * Property data feeds: connectors that import listings, sold prices and leases from outside sources.
 * Pure: mapping each provider's records to one FeedItem shape, the territory filter, schedules and the events a change produces.
 * Fetching lives in src/adapters/feed-providers.ts and storage in src/server/property-feed-db.ts.
 *
 * Providers:
 *  - reaxml: the Australian industry feed format every agency CRM exports (VaultRE, Rex, Agentbox, MRI, Box+Dice ...).
 *    One connection per agent or agency; their listings are staged in the agent's workspace, never published automatically.
 *  - domain: the Domain Group API (listings and sold results), for market data. Needs a licensed Domain API package.
 * Third-party records are stored with source 'licensed_third_party'. Their sold prices count in comparables only when staff
 * have recorded a licence that allows it on the connection (comparables_licensed + licence terms).
 */

export const FEED_PROVIDERS = ["reaxml", "domain"] as const;
export type FeedProvider = (typeof FEED_PROVIDERS)[number];
export const FEED_PROVIDER_LABELS: Record<FeedProvider, string> = { reaxml: "Agency CRM (REAXML)", domain: "Domain API" };

export const FEED_SCHEDULES = ["daily", "weekly", "manual"] as const;
export type FeedSchedule = (typeof FEED_SCHEDULES)[number];

/** Hard caps per run so one bad feed cannot flood the database. */
export const FEED_LIMITS = { maxItemsPerRun: 2000, maxFeedBytes: 20 * 1024 * 1024, fetchTimeoutMs: 20_000 } as const;

const STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"] as const;
export type AuState = (typeof STATES)[number];
const STATE_NAMES: Record<string, AuState> = {
  "new south wales": "NSW", victoria: "VIC", queensland: "QLD", "western australia": "WA", "south australia": "SA",
  tasmania: "TAS", "australian capital territory": "ACT", "northern territory": "NT"
};
export function normaliseState(v: string | undefined): AuState | undefined {
  if (!v) return undefined;
  const t = v.trim();
  const up = t.toUpperCase();
  return (STATES as readonly string[]).includes(up) ? (up as AuState) : (Object.hasOwn(STATE_NAMES, t.toLowerCase()) ? STATE_NAMES[t.toLowerCase()] : undefined);
}

export type FeedStatus = "active" | "sold" | "leased" | "withdrawn";
export type FeedPropertyType = "house" | "unit" | "townhouse" | "land" | "office" | "retail" | "industrial" | "warehouse" | "hospitality" | "other";

/** One listing or result from any provider, in this platform's terms. Money in AUD cents; rent is per week. */
export interface FeedItem {
  externalId: string;
  status: FeedStatus;
  transactionType: "sale" | "rent";
  useClass: "residential" | "commercial";
  propertyType: FeedPropertyType;
  /** Full street address when the source shows it; false when the source hid it (then the property is never matched by address). */
  address: string;
  streetAddress: boolean;
  suburb: string;
  state: AuState;
  postcode?: string;
  priceCents?: number;
  priceDisplay?: string;
  soldPriceCents?: number;
  soldAt?: string;
  listedAt?: string;
  modifiedAt?: string;
  bedrooms?: number;
  bathrooms?: number;
  parking?: number;
  landAreaSqm?: number;
  latitude?: number;
  longitude?: number;
  headline?: string;
  description?: string;
}

export interface MapResult { items: FeedItem[]; rejected: { externalId?: string; reason: string }[] }

// ---- small parsers ----

const int = (v: unknown, max = 50): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.trim()) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n) : undefined;
};
/** Whole or decimal dollars ("$1,250,000", "650", 650) to cents within the listing limits; anything else is undefined. */
export function moneyCents(v: unknown, tx: "sale" | "rent"): number | undefined {
  const raw = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : NaN;
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  const cents = Math.round(raw * 100);
  return cents <= maxPriceCents(tx) ? cents : undefined;
}
/** A positive area as given (not rounded, so hectares and acres convert exactly); callers round square metres. */
const area = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/,/g, "")) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 100_000_000 ? n : undefined;
};
const coord = (lat: unknown, lng: unknown): { latitude: number; longitude: number } | undefined => {
  const a = Number(lat), b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || (a === 0 && b === 0)) return undefined;
  return a >= AU_BOUNDS.south && a <= AU_BOUNDS.north && b >= AU_BOUNDS.west && b <= AU_BOUNDS.east ? { latitude: a, longitude: b } : undefined;
};
const clip = (s: string | undefined, max: number) => (s ? s.replace(/\s+\n/g, "\n").trim().slice(0, max) || undefined : undefined);
const postcodeOf = (v: unknown) => { const s = typeof v === "number" ? String(v).padStart(4, "0") : typeof v === "string" ? v.trim() : ""; return /^\d{4}$/.test(s) ? s : undefined; };

/**
 * Feed dates to ISO. Accepts ISO with a zone, "2026-10-01", "2026-10-01-12:30:00", "2026-10-01 12:30:00" and "20261001-123000".
 * Times without a zone are read as Australian Eastern Standard Time (+10:00), which is how REAXML CRMs send them.
 */
export function parseFeedDate(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const s = v.trim();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) && /^\d{4}-\d{2}-\d{2}T/.test(s)) { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : undefined; }
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:[-T ](\d{2}):?(\d{2})(?::?(\d{2}))?)?/.exec(s);
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}+10:00`);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

// ---- Territory ----

/** Which areas a connection imports. Empty lists mean "no limit" for that dimension; a set postcode or suburb list must match one. */
export interface Territory { states: AuState[]; postcodes: string[]; suburbs: string[] }

export function parseTerritory(v: unknown): { ok: true; value: Territory } | { ok: false; error: string } {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const list = (k: string): string[] => {
    const x = o[k];
    if (x === undefined || x === null || x === "") return [];
    const arr = Array.isArray(x) ? x : String(x).split(",");
    return [...new Set(arr.map(s => String(s).trim()).filter(Boolean))];
  };
  const states: AuState[] = [];
  for (const s of list("states")) { const n = normaliseState(s); if (!n) return { ok: false, error: `Unknown state "${s}".` }; if (!states.includes(n)) states.push(n); }
  const postcodes = list("postcodes");
  if (postcodes.some(p => !/^\d{4}$/.test(p))) return { ok: false, error: "Postcodes have four digits." };
  const suburbs = list("suburbs");
  if (suburbs.some(s => s.length > 80)) return { ok: false, error: "A suburb name is too long." };
  if (postcodes.length + suburbs.length > 200) return { ok: false, error: "At most 200 postcodes and suburbs." };
  return { ok: true, value: { states, postcodes, suburbs } };
}

export function inTerritory(t: Territory, i: Pick<FeedItem, "state" | "postcode" | "suburb">): boolean {
  if (t.states.length && !t.states.includes(i.state)) return false;
  if (!t.postcodes.length && !t.suburbs.length) return true;
  if (i.postcode && t.postcodes.includes(i.postcode)) return true;
  const sub = i.suburb.trim().toLowerCase();
  return t.suburbs.some(s => s.toLowerCase() === sub);
}

// ---- Connection settings (staff form) ----

export interface ConnectionInput {
  provider: FeedProvider;
  label: string;
  agentUserId: string | null;
  territory: Territory;
  schedule: FeedSchedule;
  sourceUrl: string | null;
  comparablesLicensed: boolean;
  licenceTerms: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[|::1)/i;

/** A pull URL a CRM gives us: https, a public host name, no credentials in the URL. */
export function feedUrlOk(v: string): boolean {
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || u.port && u.port !== "443") return false;
  return !PRIVATE_HOST.test(u.hostname) && u.hostname.includes(".");
}

export function parseConnectionInput(body: unknown): { ok: true; value: ConnectionInput } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Invalid input." };
  const b = body as Record<string, unknown>;
  const provider = FEED_PROVIDERS.find(p => p === b["provider"]);
  if (!provider) return { ok: false, error: "Choose a provider." };
  const label = typeof b["label"] === "string" ? b["label"].trim() : "";
  if (label.length < 2 || label.length > 80) return { ok: false, error: "Give the connection a name (2 to 80 characters)." };
  const schedule = FEED_SCHEDULES.find(s => s === (b["schedule"] ?? "daily"));
  if (!schedule) return { ok: false, error: "Schedule is daily, weekly or manual." };
  const t = parseTerritory(b["territory"]);
  if (!t.ok) return t;
  const agentRaw = typeof b["agentUserId"] === "string" ? b["agentUserId"].trim() : "";
  if (agentRaw && !UUID.test(agentRaw)) return { ok: false, error: "The agent id is not valid." };
  if (provider === "reaxml" && !agentRaw) return { ok: false, error: "A CRM feed belongs to an agent: enter the agent's user id." };
  const urlRaw = typeof b["sourceUrl"] === "string" ? b["sourceUrl"].trim() : "";
  if (urlRaw && !feedUrlOk(urlRaw)) return { ok: false, error: "The feed address must be a public https URL without a password in it." };
  if (provider === "domain" && urlRaw) return { ok: false, error: "The Domain API needs no feed address." };
  if (!t.value.states.length && !t.value.postcodes.length && !t.value.suburbs.length) {
    return { ok: false, error: "Set a territory (states, postcodes or suburbs) for the connection." };
  }
  const comparablesLicensed = b["comparablesLicensed"] === true;
  // An agency's own CRM is supplied by the agent, so its sold prices are not independent market evidence.
  if (comparablesLicensed && provider === "reaxml") return { ok: false, error: "Sold prices from an agency CRM feed cannot be used in comparables." };
  const terms = typeof b["licenceTerms"] === "string" ? b["licenceTerms"].trim() : "";
  if (comparablesLicensed && terms.length < 10) return { ok: false, error: "Record the licence terms that allow using these sold prices (at least 10 characters)." };
  if (terms.length > 1000) return { ok: false, error: "The licence terms are too long." };
  return {
    ok: true,
    value: { provider, label, agentUserId: agentRaw || null, territory: t.value, schedule, sourceUrl: urlRaw || null, comparablesLicensed, licenceTerms: terms || null }
  };
}

/** When a connection is next due. Daily runs at 16:00 UTC (02:00 in Queensland); weekly on Sundays. Manual never. */
export function nextRunAt(schedule: FeedSchedule, fromIso: string): string | null {
  if (schedule === "manual") return null;
  const d = new Date(fromIso);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 16, 0, 0));
  if (next.getTime() <= d.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  if (schedule === "weekly") while (next.getUTCDay() !== 6) next.setUTCDate(next.getUTCDate() + 1); // Saturday 16:00 UTC = Sunday 02:00 AEST
  return next.toISOString();
}

// ---- REAXML ----

const REAXML_KINDS = new Set(["residential", "rental", "land", "commercial", "commerciallisting", "commercialland", "rural"]);
const RES_CATEGORY: Record<string, FeedPropertyType> = {
  house: "house", villa: "house", terrace: "house", "duplexsemi-detached": "house", duplex: "house", acreage: "house", rural: "house",
  unit: "unit", apartment: "unit", flat: "unit", studio: "unit", servicedapartment: "unit", blockofunits: "unit",
  townhouse: "townhouse", retirement: "other", other: "other", alpine: "other", "semi-detached": "house"
};
const COM_CATEGORY: Record<string, FeedPropertyType> = {
  offices: "office", office: "office", retail: "retail", "showrooms/bulkygoods": "retail", "industrial/warehouse": "industrial",
  industrial: "industrial", warehouse: "warehouse", "hotel/leisure": "hospitality", hospitality: "hospitality", land: "land", "land/development": "land"
};
/** Own-key lookup (never Object.prototype names such as "constructor"), defaulting to "other". */
const lookup = (table: Record<string, FeedPropertyType>, key: string | undefined): FeedPropertyType => {
  const k = (key ?? "").toLowerCase();
  return Object.hasOwn(table, k) ? table[k]! : "other";
};
const REAXML_STATUS: Record<string, FeedStatus> = { current: "active", sold: "sold", leased: "leased", withdrawn: "withdrawn", offmarket: "withdrawn", deleted: "withdrawn" };

/** Weekly rent from a REAXML <rent period="..."> value. */
function weeklyRent(n: XmlNode | undefined): number | undefined {
  if (!n) return undefined;
  const cents = moneyCents(n.text, "rent") ?? moneyCents(n.text, "sale");
  if (cents === undefined) return undefined;
  const p = (n.attrs["period"] ?? "week").toLowerCase();
  const weekly = p.startsWith("month") ? Math.round((cents * 12) / 52) : p.startsWith("annual") || p.startsWith("year") ? Math.round(cents / 52) : cents;
  return weekly <= maxPriceCents("rent") ? weekly : undefined;
}

function reaxmlItem(n: XmlNode): FeedItem | { reject: string; externalId?: string } {
  const kind = n.name.toLowerCase();
  const externalId = textOf(n, "uniqueID");
  if (!externalId || externalId.length > 120) return { reject: "No uniqueID." };
  const agentId = textOf(n, "agentID");
  const id = agentId ? `${agentId}:${externalId}` : externalId;
  const statusKey = (n.attrs["status"] ?? "current").toLowerCase();
  const status = Object.hasOwn(REAXML_STATUS, statusKey) ? REAXML_STATUS[statusKey] : undefined;
  if (!status) return { reject: `Unknown status "${n.attrs["status"]}".`, externalId: id };
  const addr = child(n, "address");
  const suburb = textOf(addr, "suburb");
  const state = normaliseState(textOf(addr, "state"));
  if (!suburb || !state) return { reject: "Address has no suburb or Australian state.", externalId: id };
  const sub = textOf(addr, "subNumber"), num = textOf(addr, "streetNumber"), lot = textOf(addr, "lotNumber"), streetName = textOf(addr, "street");
  const number = num ? `${sub ? `${sub}/` : ""}${num}` : lot ? `Lot ${lot}` : "";
  const streetLine = `${number} ${streetName ?? ""}`.trim();
  const postcode = postcodeOf(textOf(addr, "postcode"));
  const hasStreet = !!number && !!streetName;
  const address = `${hasStreet ? `${streetLine}, ` : ""}${suburb} ${state}${postcode ? ` ${postcode}` : ""}`;

  const commercial = kind.startsWith("commercial");
  let transactionType: "sale" | "rent" = kind === "rental" ? "rent" : "sale";
  if (kind === "commercial" || kind === "commerciallisting") {
    const lt = (child(n, "commercialListingType")?.attrs["value"] ?? "sale").toLowerCase();
    if (lt === "lease") transactionType = "rent";
  }
  let propertyType: FeedPropertyType;
  if (kind === "land" || kind === "commercialland") propertyType = "land";
  else if (commercial) propertyType = lookup(COM_CATEGORY, child(n, "commercialCategory")?.attrs["name"]);
  else if (kind === "rural") propertyType = textOf(n, "features/bedrooms") ? "house" : "land";
  else propertyType = lookup(RES_CATEGORY, child(n, "category")?.attrs["name"]);

  const priceNode = child(n, "price");
  const priceCents = transactionType === "rent" ? (commercial ? undefined : weeklyRent(child(n, "rent"))) : moneyCents(priceNode?.text, "sale");
  const sold = child(n, "soldDetails");
  const garages = int(textOf(n, "features/garages")) ?? 0, carports = int(textOf(n, "features/carports")) ?? 0, open = int(textOf(n, "features/openSpaces")) ?? 0;
  const parking = textOf(n, "features/garages") || textOf(n, "features/carports") || textOf(n, "features/openSpaces") ? Math.min(garages + carports + open, 50) : undefined;
  const landNode = child(n, "landDetails/area");
  const unit = (landNode?.attrs["unit"] ?? "squareMeter").toLowerCase();
  const landRaw = area(landNode?.text);
  const factor = unit.startsWith("hectare") ? 10_000 : unit.startsWith("acre") ? 4046.86 : unit.startsWith("square") && unit.includes("feet") ? 0.0929 : 1;
  const landAreaSqm = landRaw === undefined ? undefined : Math.round(landRaw * factor) || undefined;
  const geo = coord(textOf(n, "geocode/latitude") ?? textOf(addr, "latitude"), textOf(n, "geocode/longitude") ?? textOf(addr, "longitude"));
  const soldPriceCents = moneyCents(textOf(sold, "soldPrice") ?? textOf(sold, "price"), "sale");
  const soldAt = parseFeedDate(textOf(sold, "soldDate") ?? textOf(sold, "date"));
  const item: FeedItem = {
    externalId: id, status, transactionType, useClass: commercial ? "commercial" : "residential", propertyType,
    address, streetAddress: hasStreet, suburb, state,
    ...(postcode ? { postcode } : {}),
    ...(priceCents !== undefined ? { priceCents } : {}),
    ...(textOf(n, "priceView") ? { priceDisplay: clip(textOf(n, "priceView"), 120)! } : {}),
    ...(status === "sold" && soldPriceCents !== undefined ? { soldPriceCents } : {}),
    ...(status === "sold" && soldAt ? { soldAt } : {}),
    ...(parseFeedDate(textOf(n, "listingDate") ?? textOf(n, "dateListed")) ? { listedAt: parseFeedDate(textOf(n, "listingDate") ?? textOf(n, "dateListed"))! } : {}),
    ...(parseFeedDate(n.attrs["modTime"]) ? { modifiedAt: parseFeedDate(n.attrs["modTime"])! } : {}),
    ...(int(textOf(n, "features/bedrooms")) !== undefined ? { bedrooms: int(textOf(n, "features/bedrooms"))! } : {}),
    ...(int(textOf(n, "features/bathrooms")) !== undefined ? { bathrooms: int(textOf(n, "features/bathrooms"))! } : {}),
    ...(parking !== undefined ? { parking } : {}),
    ...(landAreaSqm !== undefined ? { landAreaSqm } : {}),
    ...(geo ?? {}),
    ...(clip(textOf(n, "headline"), 200) ? { headline: clip(textOf(n, "headline"), 200)! } : {}),
    ...(clip(textOf(n, "description"), 5000) ? { description: clip(textOf(n, "description"), 5000)! } : {})
  };
  return item;
}

/** Maps a REAXML <propertyList> document. Unsupported kinds (holidayRental, business) are skipped; bad records are listed with a reason. */
export function mapReaxml(xml: string): MapResult | { error: string } {
  let doc: XmlNode;
  try { doc = parseXml(xml); } catch (e) { return { error: e instanceof XmlError ? `The feed is not valid XML: ${e.message}` : "The feed is not valid XML." }; }
  if (doc.name.toLowerCase() !== "propertylist") return { error: "Not a REAXML feed (expected <propertyList>)." };
  const out: MapResult = { items: [], rejected: [] };
  for (const n of doc.children) {
    if (!REAXML_KINDS.has(n.name.toLowerCase())) continue;
    const r = reaxmlItem(n);
    if ("reject" in r) out.rejected.push({ ...(r.externalId ? { externalId: r.externalId } : {}), reason: r.reject });
    else out.items.push(r);
  }
  return out;
}

// ---- Domain API ----

const DOMAIN_TYPE: Record<string, FeedPropertyType> = {
  house: "house", villa: "house", terrace: "house", duplex: "house", semidetached: "house", acreagesemirural: "house", rural: "house", farm: "land",
  apartmentunitflat: "unit", studio: "unit", penthouse: "unit", newapartments: "unit", blockofunits: "unit", servicedapartment: "unit",
  townhouse: "townhouse", vacantland: "land", newland: "land", developmentsite: "land", retirement: "other", carspace: "other"
};
type J = Record<string, unknown>;
const obj = (v: unknown): J => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as J) : {});

/** Flattens a Domain residential search response (PropertyListing and Project entries) to listing objects. */
export function domainListings(response: unknown): J[] {
  if (!Array.isArray(response)) return [];
  const out: J[] = [];
  for (const e of response) {
    const o = obj(e);
    if (o["type"] === "Project" && Array.isArray(o["listings"])) for (const l of o["listings"]) out.push(obj(l));
    else if (o["listing"]) out.push(obj(o["listing"]));
  }
  return out;
}

/**
 * One Domain listing to a FeedItem. `searchType` is what was searched for (Sale, Rent or Sold), because a sold result keeps its
 * original listingType. Field names follow Domain's v1 residential search; anything missing is simply left out.
 */
export function mapDomainListing(l: J, searchType: "Sale" | "Rent" | "Sold"): FeedItem | { reject: string; externalId?: string } {
  const id = l["id"];
  if ((typeof id !== "number" && typeof id !== "string") || String(id).length > 40) return { reject: "No listing id." };
  const externalId = String(id);
  const p = obj(l["propertyDetails"]);
  const state = normaliseState(typeof p["state"] === "string" ? p["state"] : undefined);
  const suburb = typeof p["suburb"] === "string" ? p["suburb"].trim() : "";
  if (!state || !suburb) return { reject: "No suburb or Australian state.", externalId };
  const postcode = postcodeOf(p["postcode"]);
  const streetNo = typeof p["streetNumber"] === "string" ? p["streetNumber"].trim() : "";
  const street = typeof p["street"] === "string" ? p["street"].trim() : "";
  const unitNo = typeof p["unitNumber"] === "string" ? p["unitNumber"].trim() : "";
  const hasStreet = !!streetNo && !!street;
  const address = `${hasStreet ? `${unitNo ? `${unitNo}/` : ""}${streetNo} ${street}, ` : ""}${suburb} ${state}${postcode ? ` ${postcode}` : ""}`;
  const listingType = String(l["listingType"] ?? searchType);
  const transactionType: "sale" | "rent" = listingType === "Rent" ? "rent" : "sale";
  const rawType = String(p["propertyType"] ?? (Array.isArray(p["allPropertyTypes"]) ? p["allPropertyTypes"][0] : "") ?? "").replace(/[^a-z]/gi, "").toLowerCase();
  const propertyType = lookup(DOMAIN_TYPE, rawType);
  const price = obj(l["priceDetails"]);
  const priceCents = moneyCents(price["price"] ?? price["priceFrom"], transactionType);
  const soldSrc = { ...obj(obj(l["saleDetails"])["soldDetails"]), ...obj(l["soldData"]) };
  const sold = searchType === "Sold" || l["status"] === "sold" || "soldDate" in soldSrc;
  const soldPriceCents = moneyCents(soldSrc["soldPrice"] ?? (sold ? price["price"] : undefined), "sale");
  const soldAt = parseFeedDate(soldSrc["soldDate"] ?? soldSrc["soldDateTime"]);
  const geo = coord(p["latitude"], p["longitude"]);
  const landRaw = area(p["landArea"]);
  const land = landRaw === undefined ? undefined : Math.round(landRaw) || undefined;
  const status: FeedStatus = sold ? "sold" : l["status"] === "withdrawn" || l["status"] === "archived" ? "withdrawn" : "active";
  const headline = typeof l["headline"] === "string" ? clip(l["headline"], 200) : undefined;
  const desc = typeof l["summaryDescription"] === "string" ? clip(l["summaryDescription"].replace(/<[^>]*>/g, " "), 5000) : undefined;
  return {
    externalId, status, transactionType, useClass: "residential", propertyType, address, streetAddress: hasStreet, suburb, state,
    ...(postcode ? { postcode } : {}),
    ...(priceCents !== undefined && !sold ? { priceCents } : {}),
    ...(typeof price["displayPrice"] === "string" ? { priceDisplay: clip(price["displayPrice"], 120)! } : {}),
    ...(sold && soldPriceCents !== undefined ? { soldPriceCents } : {}),
    ...(sold && soldAt ? { soldAt } : {}),
    ...(parseFeedDate(l["dateListed"]) ? { listedAt: parseFeedDate(l["dateListed"])! } : {}),
    ...(parseFeedDate(l["dateUpdated"]) ? { modifiedAt: parseFeedDate(l["dateUpdated"])! } : {}),
    ...(int(p["bedrooms"]) !== undefined ? { bedrooms: int(p["bedrooms"])! } : {}),
    ...(int(p["bathrooms"]) !== undefined ? { bathrooms: int(p["bathrooms"])! } : {}),
    ...(int(p["carspaces"]) !== undefined ? { parking: int(p["carspaces"])! } : {}),
    ...(land !== undefined ? { landAreaSqm: land } : {}),
    ...(geo ?? {}),
    ...(headline ? { headline } : {}),
    ...(desc ? { description: desc } : {})
  };
}

/** The body of a Domain residential search for one territory slice, one page. */
export function domainSearchBody(t: Territory, listingType: "Sale" | "Rent" | "Sold", page: number, pageSize = 100): J {
  const locations: J[] = [];
  for (const pc of t.postcodes) locations.push({ state: "", region: "", area: "", suburb: "", postCode: pc, includeSurroundingSuburbs: false });
  for (const s of t.suburbs) locations.push({ state: t.states[0] ?? "", region: "", area: "", suburb: s, postCode: "", includeSurroundingSuburbs: false });
  if (!locations.length) for (const st of t.states) locations.push({ state: st, region: "", area: "", suburb: "", postCode: "", includeSurroundingSuburbs: false });
  return { listingType, locations, pageSize, pageNumber: page, sort: { sortKey: "DateUpdated", direction: "Descending" } };
}

// ---- Changes to events ----

export type FeedEventType = "listed" | "price_changed" | "sold" | "rented" | "withdrawn";
export interface FeedEvent { type: FeedEventType; occurredAt: string; amountCents: number | null }

/**
 * What the property history gains when a record first arrives or changes. Events are idempotent in storage (one per
 * connection, property, type and time), so sending the same feed twice adds nothing.
 */
export function eventsFor(prev: FeedItem | undefined, next: FeedItem, nowIso: string): FeedEvent[] {
  const at = next.modifiedAt ?? nowIso;
  const out: FeedEvent[] = [];
  const wasActive = prev?.status === "active";
  if (next.status === "active" && !wasActive) out.push({ type: "listed", occurredAt: next.listedAt ?? at, amountCents: next.priceCents ?? null });
  if (next.status !== "active" && !prev && next.listedAt) out.push({ type: "listed", occurredAt: next.listedAt, amountCents: next.priceCents ?? null });
  if (next.status === "active" && wasActive && prev?.priceCents !== undefined && next.priceCents !== undefined && prev.priceCents !== next.priceCents) {
    out.push({ type: "price_changed", occurredAt: at, amountCents: next.priceCents });
  }
  if (next.status === "sold" && next.soldPriceCents !== undefined && next.transactionType === "sale") {
    out.push({ type: "sold", occurredAt: next.soldAt ?? at, amountCents: next.soldPriceCents });
  }
  if (next.status === "leased" && prev?.status !== "leased" && next.priceCents !== undefined) out.push({ type: "rented", occurredAt: at, amountCents: next.priceCents });
  if (next.status === "withdrawn" && wasActive) out.push({ type: "withdrawn", occurredAt: at, amountCents: null });
  return out.filter(e => Date.parse(e.occurredAt) <= Date.parse(nowIso) + 86_400_000);
}

/** A draft body (for parseDraftInput) from an imported CRM listing. The agent reviews and completes it before anything publishes. */
export function draftFromItem(i: FeedItem): Record<string, unknown> {
  const what = i.propertyType === "unit" ? "unit" : i.propertyType;
  const title = i.headline ?? `${i.bedrooms !== undefined && i.propertyType !== "land" ? `${i.bedrooms} bedroom ` : ""}${what} in ${i.suburb}`;
  return {
    title: title.slice(0, 200), address: i.address.slice(0, 300), jurisdiction: i.state, transactionType: i.transactionType,
    useClass: i.useClass, propertyType: i.propertyType, suburb: i.suburb.slice(0, 80),
    ...(i.postcode ? { postcode: i.postcode } : {}),
    ...(i.priceCents !== undefined ? { priceCents: i.priceCents } : {}),
    ...(i.bedrooms !== undefined ? { bedrooms: i.bedrooms } : {}),
    ...(i.bathrooms !== undefined ? { bathrooms: i.bathrooms } : {}),
    ...(i.parking !== undefined ? { parking: i.parking } : {}),
    ...(i.latitude !== undefined && i.longitude !== undefined ? { latitude: i.latitude, longitude: i.longitude } : {}),
    ...(i.description ? { description: i.description } : {})
  };
}

/** Stable JSON (sorted keys) used for the change hash, so key order in a feed never counts as a change. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as J).sort().map(k => `${JSON.stringify(k)}:${stableJson((v as J)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
