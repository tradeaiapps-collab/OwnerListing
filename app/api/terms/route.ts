import { NextResponse } from "next/server";
import { currentTermsVersion, hasAcceptedCurrentTerms, parseTermsAcceptance } from "../../../src/domain/terms";
import { getActor, getDb } from "../../../src/server/context";
import { csrfGuard } from "../../../src/server/csrf";
import { failure, unauthenticated } from "../../../src/server/http";
import { listAcceptances, listTermsVersions, recordAcceptance } from "../../../src/server/terms-db";

const view = (c: { version: string; textReference: string; includesAiLearningClause: boolean }) =>
  ({ version: c.version, textReference: c.textReference, includesAiLearningClause: c.includesAiLearningClause });

/** The terms in force and whether the signed-in user has accepted them. */
export async function GET(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const current = currentTermsVersion(await listTermsVersions(getDb()), new Date().toISOString());
  if (!current) return NextResponse.json({ current: null, accepted: false });
  const accepted = hasAcceptedCurrentTerms(await listAcceptances(getDb(), actor.userId), actor.userId, current);
  return NextResponse.json({ current: view(current), accepted });
}

/** Body: { version, agree: true }. Adds one row to the acceptance log; nothing is ever updated or removed. */
export async function POST(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const current = currentTermsVersion(await listTermsVersions(getDb()), new Date().toISOString());
  const parsed = parseTermsAcceptance(await req.json().catch(() => null), current);
  if (!parsed.ok) return failure(parsed);
  await recordAcceptance(getDb(), actor.userId, parsed.value.version);
  return NextResponse.json({ accepted: true, version: parsed.value.version });
}
