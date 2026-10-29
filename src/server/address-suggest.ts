import { randomUUID } from "node:crypto";
import { addressLookupFromEnv } from "../adapters/address-lookup";
import {
  isPlaceId, normaliseAddressQuery, sessionTokenOr, ADDRESS_QUERY_MIN, ADDRESS_QUERY_MAX,
  type AddressLookupPort, type AddressParts, type AddressProvider, type AddressSuggestion
} from "../domain/address-suggest";
import { withinLimit, windowStart } from "../domain/rate-limit";
import { sha256Hex } from "../domain/phone-verification";
import type { Failure, Result } from "../domain/listing-service";
import type { Queryable } from "./db";
import { countHitPg } from "./offer-flow-db";

/** Lookups per signed-in person per 10 minutes. The field waits for a pause in typing, so one address takes a handful. */
export const ADDRESS_LOOKUP_RATE = { windowMs: 10 * 60 * 1000, perPerson: 150, perIp: 400 } as const;

export interface AddressSuggestDeps { hit(bucket: string, windowMs: number): Promise<number | undefined>; port: AddressLookupPort | null }

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const OFF = "Address suggestions are not available. Type the full address.";

async function limited(d: AddressSuggestDeps, personId: string, ip: string): Promise<boolean> {
  // Both counters are always hit, so several accounts from one address still share the per-IP budget. Fails closed.
  const person = await d.hit(sha256Hex(`address-lookup:${personId}`), ADDRESS_LOOKUP_RATE.windowMs);
  const addr = await d.hit(sha256Hex(`address-lookup-ip:${ip}`), ADDRESS_LOOKUP_RATE.windowMs);
  return !withinLimit(person, ADDRESS_LOOKUP_RATE.perPerson) || !withinLimit(addr, ADDRESS_LOOKUP_RATE.perIp);
}

/** Suggestions for what the person has typed so far. */
export async function runAddressSuggest(
  d: AddressSuggestDeps, personId: string, q: unknown, session: unknown, ip: string = "unknown"
): Promise<Result<{ provider: AddressProvider; suggestions: AddressSuggestion[] }>> {
  if (!d.port) return fail("unavailable", OFF);
  const query = normaliseAddressQuery(q);
  if (query === null) return fail("invalid", `Type ${ADDRESS_QUERY_MIN} to ${ADDRESS_QUERY_MAX} characters of the address.`);
  if (await limited(d, personId, ip)) return fail("rate_limited", "Too many address lookups. Type the full address or try again in a few minutes.");
  try {
    return { ok: true, value: { provider: d.port.provider, suggestions: await d.port.suggest(query, sessionTokenOr(session, randomUUID())) } };
  } catch {
    return fail("unavailable", OFF);
  }
}

/** The address parts for a picked suggestion that came without them (Google). */
export async function runAddressResolve(d: AddressSuggestDeps, personId: string, id: unknown, session: unknown, ip: string = "unknown"): Promise<Result<AddressParts>> {
  if (!d.port) return fail("unavailable", OFF);
  if (!isPlaceId(id)) return fail("invalid", "Unknown address.");
  if (await limited(d, personId, ip)) return fail("rate_limited", "Too many address lookups. Type the full address or try again in a few minutes.");
  try {
    const parts = await d.port.resolve(id, sessionTokenOr(session, randomUUID()));
    return parts ? { ok: true, value: parts } : fail("not_found", "That address could not be found in Australia. Type it in full.");
  } catch {
    return fail("unavailable", OFF);
  }
}

export const addressSuggestDeps = (db: Queryable): AddressSuggestDeps => ({
  hit: (bucket, windowMs) => countHitPg(db, bucket, windowStart(new Date().toISOString(), windowMs)),
  port: addressLookupFromEnv()
});
