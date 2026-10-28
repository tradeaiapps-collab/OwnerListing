import { NextResponse } from "next/server";
import { clientIp } from "../../../../../../src/server/client-ip";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { startSms } from "../../../../../../src/server/mfa";
import { getMfaDeps, getSessionState, mfaRequiredResponse } from "../../../../../../src/server/mfa-context";
import { withApi } from "../../../../../../src/server/api/with-api";

/** Body: { phone, consent: true }. Starts text-message set-up and texts a 6-digit code to the number. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const s = await getSessionState(req);
  if (!s) return unauthenticated();
  if (s.mfa.enrolled && !s.mfa.satisfied) return mfaRequiredResponse();
  const r = await startSms(await getMfaDeps(), s.actor.userId, clientIp(req), await req.json().catch(() => null));
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const POST = withApi(handlePost);
