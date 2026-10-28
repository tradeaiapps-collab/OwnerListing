import { NextResponse } from "next/server";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { regenerateRecoveryCodes } from "../../../../../src/server/mfa";
import { getMfaDeps, getSessionState, requireRecentMfa } from "../../../../../src/server/mfa-context";
import { withApi } from "../../../../../src/server/api/with-api";

/** Issues a fresh set of 10 recovery codes (shown once); the old set stops working. Needs a check in the last 15 minutes. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const s = await getSessionState(req);
  if (!s) return unauthenticated();
  const stale = await requireRecentMfa(req);
  if (stale) return stale;
  const r = await regenerateRecoveryCodes(await getMfaDeps(), s.actor.userId);
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : failure(r);
}

export const POST = withApi(handlePost);
