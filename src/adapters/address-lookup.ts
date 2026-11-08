import {
  addressParts, auPoint, isPlaceId, MAX_SUGGESTIONS, type AddressLookupPort, type AddressParts, type AddressSuggestion, type GeoPoint
} from "../domain/address-suggest";

type FetchInit = { method?: "GET" | "POST"; redirect: "error"; signal: AbortSignal; headers: Record<string, string>; body?: string };
type FetchLike = (url: string, init: FetchInit) => Promise<{ ok: boolean; text(): Promise<string> }>;

const GOOGLE_HOST = "https://places.googleapis.com/v1"; // fixed host: never built from input
const PUBLIC_PHOTON = "https://photon.komoot.io";
const TIMEOUT_MS = 5000;
const MAX_BODY = 256 * 1024;
/** Mainland Australia and Tasmania (west, south, east, north). */
const AU_BBOX = "112.9,-43.7,153.7,-10.6";
/** Results lean towards South East Queensland, the beta region. */
const BIAS = { lat: "-27.47", lon: "153.03" };

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

async function getJson(fetchFn: FetchLike, url: string, init: Omit<FetchInit, "redirect" | "signal">): Promise<Record<string, unknown>> {
  let body: string;
  try {
    const res = await fetchFn(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error("not ok");
    body = await res.text();
  } catch {
    throw new Error("Address lookup unavailable."); // never pass the original error on: it may carry the key or the URL
  }
  if (body.length > MAX_BODY) throw new Error("Unexpected address lookup reply.");
  let j: unknown;
  try { j = JSON.parse(body); } catch { throw new Error("Unexpected address lookup reply."); }
  const o = obj(j);
  if (!o) throw new Error("Unexpected address lookup reply.");
  return o;
}

/**
 * Google Places API (New): Autocomplete for the list, Place Details (address components only) for the picked one.
 * Both calls carry the same session token so Google bills them as one session.
 */
export function createGooglePlaces(apiKey: string, fetchFn: FetchLike = (u, i) => fetch(u, i)): AddressLookupPort {
  const key = apiKey.trim();
  if (key === "") throw new Error("A Google Places API key is required.");
  return {
    provider: "google",
    async suggest(query, sessionToken) {
      const j = await getJson(fetchFn, `${GOOGLE_HOST}/places:autocomplete`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ input: query, includedRegionCodes: ["au"], languageCode: "en-AU", sessionToken })
      });
      return parseGoogleSuggestions(j);
    },
    async resolve(id, sessionToken) {
      if (!isPlaceId(id)) return null;
      const qs = new URLSearchParams({ languageCode: "en-AU", sessionToken }).toString();
      const j = await getJson(fetchFn, `${GOOGLE_HOST}/places/${encodeURIComponent(id)}?${qs}`, {
        method: "GET",
        headers: { "x-goog-api-key": key, "x-goog-fieldmask": "addressComponents" }
      });
      return parseGooglePlace(j);
    },
    async locate(address) {
      const j = await getJson(fetchFn, `${GOOGLE_HOST}/places:searchText`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key, "x-goog-fieldmask": "places.location" },
        body: JSON.stringify({ textQuery: address, regionCode: "au", languageCode: "en-AU", pageSize: 1 })
      });
      return parseGoogleLocation(j);
    }
  };
}

/** Exported for tests. First place with a position inside Australia. */
export function parseGoogleLocation(j: Record<string, unknown>): GeoPoint | null {
  const places = Array.isArray(j["places"]) ? j["places"] : [];
  for (const p of places) {
    const loc = obj(obj(p)?.["location"]);
    const pt = auPoint(loc?.["latitude"], loc?.["longitude"]);
    if (pt) return pt;
  }
  return null;
}

/** Exported for tests. */
export function parseGoogleSuggestions(j: Record<string, unknown>): AddressSuggestion[] {
  const list = Array.isArray(j["suggestions"]) ? j["suggestions"] : [];
  const out: AddressSuggestion[] = [];
  for (const s of list) {
    const p = obj(obj(s)?.["placePrediction"]);
    const id = p?.["placeId"];
    if (!p || !isPlaceId(id)) continue;
    const fmt = obj(p["structuredFormat"]);
    const full = str(obj(p["text"])?.["text"]) ?? "";
    const main = str(obj(fmt?.["mainText"])?.["text"]) ?? full;
    const secondary = (str(obj(fmt?.["secondaryText"])?.["text"]) ?? "").replace(/,?\s*Australia$/, "");
    if (main.trim() === "") continue;
    out.push({ id, main: main.slice(0, 200), secondary: secondary.slice(0, 200) });
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}

/** Exported for tests. Null outside Australia or without a street line. */
export function parseGooglePlace(j: Record<string, unknown>): AddressParts | null {
  const comps = Array.isArray(j["addressComponents"]) ? j["addressComponents"] : [];
  const find = (type: string, short = false): string | undefined => {
    for (const c of comps) {
      const o = obj(c);
      if (o && Array.isArray(o["types"]) && o["types"].includes(type)) return str(o[short ? "shortText" : "longText"]);
    }
    return undefined;
  };
  if (find("country", true) !== "AU") return null;
  const route = find("route", true) ?? find("route");
  const number = find("street_number");
  const sub = find("subpremise");
  const streetNo = number ? (sub ? `${sub}/${number}` : number) : undefined;
  const street = route ? [streetNo, route].filter(Boolean).join(" ") : find("premise");
  return addressParts({ street, suburb: find("locality") ?? find("sublocality") ?? find("postal_town"), state: find("administrative_area_level_1", true), postcode: find("postal_code") });
}

/**
 * Photon (OpenStreetMap data). Used when no Google key is set. The public instance is fair-use only, like OSM's public map tiles:
 * fine for local testing and a small beta, not for launch traffic. ADDRESS_PHOTON_URL points at a self-hosted instance instead.
 */
export function createPhoton(baseUrl: string = PUBLIC_PHOTON, fetchFn: FetchLike = (u, i) => fetch(u, i)): AddressLookupPort {
  const base = baseUrl.replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s?#]+$/.test(base)) throw new Error("ADDRESS_PHOTON_URL must be an https origin.");
  return {
    provider: "osm",
    async suggest(query) {
      const qs = new URLSearchParams({ q: query, limit: String(MAX_SUGGESTIONS * 2), lang: "en", bbox: AU_BBOX, ...BIAS });
      qs.append("layer", "house");
      qs.append("layer", "street");
      const j = await getJson(fetchFn, `${base}/api/?${qs.toString()}`, { method: "GET", headers: { accept: "application/json" } });
      return parsePhoton(j);
    },
    // Photon suggestions always carry their parts, so the client never asks to resolve one.
    async resolve() { return null; },
    async locate(address) {
      const qs = new URLSearchParams({ q: address, limit: "5", lang: "en", bbox: AU_BBOX, ...BIAS });
      for (const layer of ["house", "street", "locality", "district"]) qs.append("layer", layer);
      const j = await getJson(fetchFn, `${base}/api/?${qs.toString()}`, { method: "GET", headers: { accept: "application/json" } });
      return parsePhotonLocation(j);
    }
  };
}

/** Exported for tests. First Australian feature with a position; Photon lists the best match first. */
export function parsePhotonLocation(j: Record<string, unknown>): GeoPoint | null {
  const feats = Array.isArray(j["features"]) ? j["features"] : [];
  for (const f of feats) {
    const o = obj(f);
    if (str(obj(o?.["properties"])?.["countrycode"])?.toUpperCase() !== "AU") continue;
    const c = obj(o?.["geometry"])?.["coordinates"]; // GeoJSON order: [longitude, latitude]
    const pt = Array.isArray(c) ? auPoint(c[1], c[0]) : null;
    if (pt) return pt;
  }
  return null;
}

/** Exported for tests. Keeps Australian street and house results that have a street line; drops duplicates. */
export function parsePhoton(j: Record<string, unknown>): AddressSuggestion[] {
  const feats = Array.isArray(j["features"]) ? j["features"] : [];
  const out: AddressSuggestion[] = [];
  const seen = new Set<string>();
  for (const f of feats) {
    const p = obj(obj(f)?.["properties"]);
    if (!p || str(p["countrycode"])?.toUpperCase() !== "AU") continue;
    const streetName = str(p["street"]) ?? (p["type"] === "street" ? str(p["name"]) : undefined);
    if (!streetName) continue;
    const street = [str(p["housenumber"]), streetName].filter(Boolean).join(" ");
    // In Australian OSM data "district" is usually the suburb and "city" the council area (e.g. "Brisbane City").
    const parts = addressParts({ street, suburb: str(p["district"]) ?? str(p["city"]) ?? str(p["locality"]), state: p["state"], postcode: p["postcode"] });
    if (!parts || seen.has(parts.address)) continue;
    seen.add(parts.address);
    const id = `${str(p["osm_type"]) ?? "X"}${typeof p["osm_id"] === "number" ? p["osm_id"] : out.length}`;
    out.push({ id, main: street, secondary: [parts.suburb, parts.state, parts.postcode].filter(Boolean).join(" "), parts });
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}

/** GOOGLE_PLACES_API_KEY picks Google; otherwise Photon (ADDRESS_PHOTON_URL or the public instance). ADDRESS_LOOKUP=off turns it off. */
export function addressLookupFromEnv(env: NodeJS.ProcessEnv = process.env, fetchFn?: FetchLike): AddressLookupPort | null {
  if ((env.ADDRESS_LOOKUP ?? "").trim().toLowerCase() === "off") return null;
  const key = (env.GOOGLE_PLACES_API_KEY ?? "").trim();
  if (key !== "") return createGooglePlaces(key, fetchFn);
  return createPhoton((env.ADDRESS_PHOTON_URL ?? "").trim() || PUBLIC_PHOTON, fetchFn);
}
