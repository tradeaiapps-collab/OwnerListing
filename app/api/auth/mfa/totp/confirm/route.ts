import { NextResponse } from "next/server";
import { clientIp } from "../../../../../../src/server/client-ip";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { confirmFactor } from "../../../../../../src/server/mfa";
import { getMfaDeps, getSessionState, mfaRequiredResponse, markMfaPassed } from "../../../../../../src/server/mfa-context";
import { withApi } from "../../../../../../src/server/api/with-api";

/** Body: { code }. Finishes setting up the authenticator app. The first method also returns 10 recovery codes, shown once. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const s = await getSessionState(req);
  if (!s) return unauthenticated();
  // A second method can only be added by a session that has already passed MFA.
  if (s.mfa.enrolled && !s.mfa.satisfied) return mfaRequiredResponse();
  const r = await confirmFactor(await getMfaDeps(), s.actor.userId, clientIp(req), "totp", await req.json().catch(() => null));
  return r.ok ? markMfaPassed(NextResponse.json({ enrolled: true, ...r.value }, { headers: { "cache-control": "no-store" } }), s) : failure(r);
}

export const POST = withApi(handlePost);
