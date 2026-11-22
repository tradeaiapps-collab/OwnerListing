import { inviteContractor, listAssignments, type AssignmentIds, type AssignmentRepository } from "./assignment-service";
import { isTrade, type Trade } from "./contractor-market";
import type { Actor, Result } from "./listing-service";

export const DISPATCH_KINDS = ["photographer", "inspector"] as const;
export type DispatchKind = typeof DISPATCH_KINDS[number];

export interface ContractorProfile { acceptingNew: boolean; servicePostcodes: string[]; serviceSuburbs: string[] }
export interface ContractorCandidate { userId: string; displayName: string; profile: ContractorProfile; openJobs: number }

export interface ContractorProfileStore {
  /** Active, non-suspended accounts with a profile for this kind. */
  candidates(kind: DispatchKind): Promise<ContractorCandidate[]>;
  get(userId: string, kind: Trade): Promise<ContractorProfile | undefined>;
  save(userId: string, kind: Trade, p: ContractorProfile): Promise<void>;
}

const norm = (s: string) => s.trim().toLowerCase();

/** The best matching contractor for the listing's area, or undefined. A suburb match beats a postcode match; fewer open jobs breaks ties; then id, so it is repeatable. */
export function pickContractor(area: { suburb?: string; postcode?: string }, candidates: readonly ContractorCandidate[], excludeUserId?: string): ContractorCandidate | undefined {
  const suburb = area.suburb ? norm(area.suburb) : "", postcode = area.postcode?.trim() ?? "";
  const scored = candidates.flatMap(c => {
    if (!c.profile.acceptingNew || c.userId === excludeUserId) return [];
    const bySuburb = suburb !== "" && c.profile.serviceSuburbs.map(norm).includes(suburb);
    const byPostcode = postcode !== "" && c.profile.servicePostcodes.includes(postcode);
    return bySuburb || byPostcode ? [{ c, score: (bySuburb ? 2 : 0) + (byPostcode ? 1 : 0) }] : [];
  });
  scored.sort((a, b) => b.score - a.score || a.c.openJobs - b.c.openJobs || a.c.userId.localeCompare(b.c.userId));
  return scored[0]?.c;
}

export type DispatchOutcome = { kind: DispatchKind; result: "invited" | "already" | "none_nearby"; name?: string };

/**
 * Sends the first invitation for a photographer and for an inspector where an account in the listing's suburb or postcode has opted in.
 * Uses the normal invitation (the contractor must accept; the owner can cancel). Kinds that already have a live invitation are left alone.
 * Where nobody matches, nothing is sent and the owner uses the invite form.
 */
export async function autoDispatch(
  repo: AssignmentRepository, profiles: ContractorProfileStore, actor: Actor, listingId: string,
  area: { suburb?: string; postcode?: string }, ids: AssignmentIds
): Promise<Result<DispatchOutcome[]>> {
  const existing = await listAssignments(repo, actor, listingId);
  if (!existing.ok) return existing;
  const out: DispatchOutcome[] = [];
  for (const kind of DISPATCH_KINDS) {
    if (existing.value.some(a => a.kind === kind && a.status !== "cancelled")) { out.push({ kind, result: "already" }); continue; }
    // A declined contractor is not asked again for this listing.
    const declined = new Set((await repo.listForUser(actor.userId, listingId)).filter(a => a.kind === kind).map(a => a.counterpartName));
    const pick = pickContractor(area, (await profiles.candidates(kind)).filter(c => !declined.has(c.displayName)), actor.userId);
    if (!pick) { out.push({ kind, result: "none_nearby" }); continue; }
    const r = await inviteContractor(repo, actor, listingId, { kind, contractorUserId: pick.userId }, ids);
    out.push(r.ok ? { kind, result: "invited", name: pick.displayName } : { kind, result: "none_nearby" });
  }
  return { ok: true, value: out };
}

const POSTCODE = /^\d{4}$/;
/** Validates a contractor's own profile body. */
export function parseContractorProfile(input: unknown): Result<{ kind: Trade; profile: ContractorProfile }> {
  const bad = (m: string): Result<never> => ({ ok: false, code: "invalid", message: m });
  if (typeof input !== "object" || input === null) return bad("Send a JSON object.");
  const o = input as Record<string, unknown>;
  if (!isTrade(o["kind"])) return bad("Choose photographer, building inspector, pest control or other trade.");
  const list = (v: unknown) => (Array.isArray(v) && v.every(x => typeof x === "string") ? (v as string[]).map(s => s.trim()).filter(Boolean) : undefined);
  const postcodes = list(o["servicePostcodes"] ?? []), suburbs = list(o["serviceSuburbs"] ?? []);
  if (!postcodes || !suburbs || postcodes.length > 200 || suburbs.length > 200) return bad("Areas must be lists of up to 200 postcodes and suburbs.");
  if (!postcodes.every(p => POSTCODE.test(p)) || !suburbs.every(s => s.length <= 80)) return bad("Postcodes are four digits; suburb names are under 80 characters.");
  if (typeof (o["acceptingNew"] ?? false) !== "boolean") return bad("acceptingNew must be true or false.");
  return { ok: true, value: { kind: o["kind"], profile: { acceptingNew: (o["acceptingNew"] ?? false) as boolean, servicePostcodes: [...new Set(postcodes)], serviceSuburbs: [...new Set(suburbs.map(s => s))] } } };
}
