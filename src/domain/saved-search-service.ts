import type { AlertPreference, SavedSearch } from "./buyer";
import { AU_JURISDICTIONS } from "./jurisdiction";
import { AMENITIES, AU_BOUNDS } from "./listing-details";
import { MAX_RADIUS_KM } from "./listing-search";
import { PROPERTY_TYPES, TRANSACTION_TYPES, USE_CLASSES, type Failure, type Result } from "./listing-service";

export const MAX_SEARCHES_PER_BUYER = 20;
export const MAX_SUBURBS_PER_SEARCH = 10;
const MAX_SUBURB_LENGTH = 80;
const MAX_PRICE_CENTS = 100_000_000_000;
const MAX_BEDROOMS = 20;
/** Smallest price a real listing can have: a studio or unit is listed as 1 bedroom, and nobody buys for under $10,000 or rents for under $50 a week. */
export const MIN_BEDROOMS = 1;
export const MIN_SALE_PRICE_CENTS = 1_000_000;
export const MIN_RENT_PRICE_CENTS = 5_000;

export type SavedSearchInput = Omit<SavedSearch, "id" | "buyerUserId" | "active">;
export type AlertChannel = AlertPreference["channel"];
export interface AlertConsentInput { channel: AlertChannel; consent: boolean }

export interface SavedSearchRepository {
  list(buyerUserId: string): Promise<SavedSearch[]>;
  insert(buyerUserId: string, input: SavedSearchInput): Promise<SavedSearch>;
  /** Removes one of the buyer's own searches. Returns false when it does not exist or belongs to someone else. */
  remove(buyerUserId: string, searchId: string): Promise<boolean>;
  listPreferences(buyerUserId: string): Promise<AlertPreference[]>;
  giveConsent(buyerUserId: string, channel: AlertChannel, nowIso: string): Promise<void>;
  unsubscribe(buyerUserId: string, channel: AlertChannel, nowIso: string): Promise<void>;
}

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  typeof v === "string" ? allowed.find(a => a === v) : undefined;

/** A saved search holds property facts only. Any other key is rejected, so demographic or personal fields cannot be stored. */
const SEARCH_KEYS = [
  "transactionType", "useClass", "jurisdictions", "suburbs", "propertyTypes",
  "minPriceCents", "maxPriceCents", "minBedrooms", "minBathrooms", "minParking", "amenities", "near"
] as const;

function stringList<T extends string>(v: unknown, allowed: readonly T[], label: string): Result<T[]> {
  if (v === undefined) return { ok: true, value: [] };
  if (!Array.isArray(v) || v.length > allowed.length) return fail("invalid", `Invalid ${label}.`);
  const out: T[] = [];
  for (const item of v) {
    const m = oneOf(item, allowed);
    if (!m) return fail("invalid", `Invalid ${label}.`);
    if (!out.includes(m)) out.push(m);
  }
  return { ok: true, value: out };
}

function intField(b: Record<string, unknown>, key: string, max: number, label: string): Result<number | undefined> {
  const v = b[key];
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) return fail("invalid", `Invalid ${label}.`);
  return { ok: true, value: v };
}

export function parseSavedSearchInput(body: unknown): Result<SavedSearchInput> {
  if (!isObject(body)) return fail("invalid", "Send a JSON object.");
  const extra = Object.keys(body).find(k => !(SEARCH_KEYS as readonly string[]).includes(k));
  if (extra !== undefined) return fail("invalid", `Unsupported field: ${extra}.`);

  const transactionType = oneOf(body["transactionType"], TRANSACTION_TYPES);
  if (!transactionType) return fail("invalid", "Choose sale or rent.");
  const useClass = oneOf(body["useClass"], USE_CLASSES);
  if (!useClass) return fail("invalid", "Choose residential or commercial.");

  const jurisdictions = stringList(body["jurisdictions"], AU_JURISDICTIONS, "state");
  if (!jurisdictions.ok) return jurisdictions;
  const propertyTypes = stringList(body["propertyTypes"], PROPERTY_TYPES, "property type");
  if (!propertyTypes.ok) return propertyTypes;

  const suburbs: string[] = [];
  const rawSuburbs = body["suburbs"];
  if (rawSuburbs !== undefined) {
    if (!Array.isArray(rawSuburbs) || rawSuburbs.length > MAX_SUBURBS_PER_SEARCH) return fail("invalid", `Use at most ${MAX_SUBURBS_PER_SEARCH} suburbs.`);
    for (const s of rawSuburbs) {
      if (typeof s !== "string") return fail("invalid", "Invalid suburb.");
      const t = s.trim();
      if (t.length === 0 || t.length > MAX_SUBURB_LENGTH) return fail("invalid", "Invalid suburb.");
      if (!suburbs.some(x => x.toLowerCase() === t.toLowerCase())) suburbs.push(t);
    }
  }

  const min = intField(body, "minPriceCents", MAX_PRICE_CENTS, "minimum price");
  if (!min.ok) return min;
  const max = intField(body, "maxPriceCents", MAX_PRICE_CENTS, "maximum price");
  if (!max.ok) return max;
  if (min.value !== undefined && max.value !== undefined && min.value > max.value) return fail("invalid", "Minimum price is above maximum price.");
  const floor = transactionType === "sale" ? MIN_SALE_PRICE_CENTS : MIN_RENT_PRICE_CENTS;
  for (const [v, label] of [[min.value, "minimum"], [max.value, "maximum"]] as const) {
    if (v !== undefined && v > 0 && v < floor)
      return fail("invalid", transactionType === "sale"
        ? `The ${label} price looks too low. Homes for sale start around $10,000.`
        : `The ${label} price looks too low. Rent is entered per week and starts around $50.`);
  }
  const beds = intField(body, "minBedrooms", MAX_BEDROOMS, "bedrooms");
  if (!beds.ok) return beds;
  if (useClass === "residential" && beds.value !== undefined && beds.value < MIN_BEDROOMS) return fail("invalid", "Studios are typically listed as 1+ bedrooms. Choose 1 or more, or leave bedrooms blank.");

  const baths = intField(body, "minBathrooms", MAX_BEDROOMS, "bathrooms");
  if (!baths.ok) return baths;
  const parking = intField(body, "minParking", MAX_BEDROOMS, "parking");
  if (!parking.ok) return parking;
  const amenities = stringList(body["amenities"], AMENITIES, "feature");
  if (!amenities.ok) return amenities;
  const near = parseNearInput(body["near"]);
  if (!near.ok) return near;

  return {
    ok: true,
    value: {
      transactionType, useClass,
      jurisdictions: jurisdictions.value, suburbs, propertyTypes: propertyTypes.value,
      ...(min.value !== undefined ? { minPriceCents: min.value } : {}),
      ...(max.value !== undefined ? { maxPriceCents: max.value } : {}),
      ...(beds.value !== undefined ? { minBedrooms: beds.value } : {}),
      ...(baths.value !== undefined && baths.value > 0 ? { minBathrooms: baths.value } : {}),
      ...(parking.value !== undefined && parking.value > 0 ? { minParking: parking.value } : {}),
      ...(amenities.value.length > 0 ? { amenities: amenities.value } : {}),
      ...(near.value !== undefined ? { near: near.value } : {})
    }
  };
}

/** { latitude, longitude, radiusKm } inside Australia with a radius of 1 to 100 km, or absent. */
function parseNearInput(v: unknown): Result<SavedSearchInput["near"]> {
  if (v === undefined) return { ok: true, value: undefined };
  const bad = fail("invalid", "Choose a point in Australia and a distance of 1 to 100 km.");
  if (!isObject(v) || Object.keys(v).some(k => k !== "latitude" && k !== "longitude" && k !== "radiusKm")) return bad;
  const { latitude, longitude, radiusKm } = v;
  if (typeof latitude !== "number" || typeof longitude !== "number" || typeof radiusKm !== "number") return bad;
  if (!(latitude >= AU_BOUNDS.south && latitude <= AU_BOUNDS.north && longitude >= AU_BOUNDS.west && longitude <= AU_BOUNDS.east)) return bad;
  if (!(radiusKm >= 1 && radiusKm <= MAX_RADIUS_KM)) return bad;
  return { ok: true, value: { latitude, longitude, radiusKm } };
}

/** consent must be an explicit boolean: true opts in to the channel, false unsubscribes. */
export function parseAlertConsentInput(body: unknown): Result<AlertConsentInput> {
  if (!isObject(body)) return fail("invalid", "Send a JSON object.");
  const extra = Object.keys(body).find(k => k !== "channel" && k !== "consent");
  if (extra !== undefined) return fail("invalid", `Unsupported field: ${extra}.`);
  const channel = oneOf(body["channel"], ["email", "sms"] as const);
  if (!channel) return fail("invalid", "Choose email or sms.");
  if (typeof body["consent"] !== "boolean") return fail("invalid", "Consent must be true or false.");
  return { ok: true, value: { channel, consent: body["consent"] } };
}

export async function createSavedSearch(
  repo: SavedSearchRepository, buyerUserId: string, input: SavedSearchInput
): Promise<Result<SavedSearch>> {
  const existing = await repo.list(buyerUserId);
  if (existing.length >= MAX_SEARCHES_PER_BUYER) return fail("conflict", `You can keep up to ${MAX_SEARCHES_PER_BUYER} saved searches.`);
  return { ok: true, value: await repo.insert(buyerUserId, input) };
}

/** Records the buyer's choice for one channel. Opting out never deletes the record. */
export async function setAlertConsent(
  repo: SavedSearchRepository, buyerUserId: string, input: AlertConsentInput, nowIso: string
): Promise<AlertPreference[]> {
  if (input.consent) await repo.giveConsent(buyerUserId, input.channel, nowIso);
  else await repo.unsubscribe(buyerUserId, input.channel, nowIso);
  return repo.listPreferences(buyerUserId);
}

/** Deletes a saved search the buyer owns. A saved search is a preference, not chat or a published file. */
export async function deleteSavedSearch(
  repo: SavedSearchRepository, buyerUserId: string, searchId: string
): Promise<Result<{ deleted: true }>> {
  if (searchId.length === 0 || searchId.length > 64) return fail("not_found", "Saved search not found.");
  return (await repo.remove(buyerUserId, searchId))
    ? { ok: true, value: { deleted: true } }
    : fail("not_found", "Saved search not found.");
}
