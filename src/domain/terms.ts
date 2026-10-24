import type { Failure, Result } from "./listing-service";

export interface TermsVersion { version: string; includesAiLearningClause: boolean }
export interface TermsVersionRow extends TermsVersion { textReference: string; effectiveAt: string }
export interface TermsAcceptance { userId: string; version: string }

/** Posting is blocked until the user has accepted the current terms version. */
export function hasAcceptedCurrentTerms(
  acceptances: readonly TermsAcceptance[],
  userId: string,
  current: TermsVersion
): boolean {
  return acceptances.some(a => a.userId === userId && a.version === current.version);
}

/** AI learning is covered only if the user accepted a version that contains the AI-learning clause. */
export function aiLearningCovered(
  acceptances: readonly TermsAcceptance[],
  userId: string,
  current: TermsVersion
): boolean {
  return current.includesAiLearningClause && hasAcceptedCurrentTerms(acceptances, userId, current);
}

/** The version in force at `nowIso`: the latest one already effective. Undefined when none is, so callers must fail closed. */
export function currentTermsVersion(versions: readonly TermsVersionRow[], nowIso: string): TermsVersionRow | undefined {
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) return undefined;
  return [...versions]
    .filter(v => Date.parse(v.effectiveAt) <= now)
    .sort((a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt) || b.version.localeCompare(a.version))[0];
}

/** Gate for key actions. Null means go ahead; otherwise a forbidden failure. No version in force also blocks. */
export function termsGate(
  acceptances: readonly TermsAcceptance[],
  userId: string,
  current: TermsVersion | undefined
): Failure | null {
  return termsGateFor(current !== undefined && hasAcceptedCurrentTerms(acceptances, userId, current));
}

/** Same gate once the lookup is done: only an explicit true passes, anything else is the forbidden failure. */
export function termsGateFor(accepted: unknown): Failure | null {
  return accepted === true ? null : { ok: false, code: "forbidden", message: "Accept the current terms and privacy policy to continue." };
}

/** Body: { version, agree: true }. The version must be the one in force, so an old or invented version is refused. */
export function parseTermsAcceptance(body: unknown, current: TermsVersion | undefined): Result<{ version: string }> {
  const bad = (message: string): Failure => ({ ok: false, code: "invalid", message });
  if (current === undefined) return bad("No terms are in force yet.");
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("Send a JSON object.");
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find(k => k !== "version" && k !== "agree");
  if (extra !== undefined) return bad(`Unsupported field: ${extra}.`);
  if (b["agree"] !== true) return bad("You must agree to the terms and privacy policy.");
  if (b["version"] !== current.version) return bad("These terms are out of date. Reload and read the current version.");
  return { ok: true, value: { version: current.version } };
}
