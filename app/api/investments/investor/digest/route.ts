import { NextResponse } from "next/server";
import { parseInvestorDigestInput } from "../../../../../src/domain/investor-digest";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { getInvestorDigest, setInvestorDigest } from "../../../../../src/server/investor-digest-db";
import { withApi } from "../../../../../src/server/api/with-api";

/** The signed-in user's own weekly investor digest choice. On unless they turn it off. PUT body: { enabled: boolean }. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json({ digest: await getInvestorDigest(getDb(), actor.userId) });
}
async function handlePut(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const parsed = parseInvestorDigestInput(await req.json().catch(() => null));
  if (!parsed.ok) return failure({ ok: false, code: "invalid", message: parsed.message });
  await setInvestorDigest(getDb(), actor.userId, parsed.enabled);
  return NextResponse.json({ digest: await getInvestorDigest(getDb(), actor.userId) });
}
export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
