import { NextResponse } from "next/server";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { removeFactor } from "../../../../../../src/server/mfa";
import { getMfaDeps, getSessionState, markMfaPassed, requireRecentMfa } from "../../../../../../src/server/mfa-context";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Removes a sign-in method. Needs a check in the last 15 minutes. Other sessions that passed MFA before now are signed out of MFA. */
async function handleDelete(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const s = await getSessionState(req);
  if (!s) return unauthenticated();
  const stale = await requireRecentMfa(req);
  if (stale) return stale;
  const r = await removeFactor(await getMfaDeps(), s, (await params).id);
  return r.ok ? markMfaPassed(NextResponse.json(r.value), s) : failure(r);
}

export const DELETE = withApi(handleDelete);
