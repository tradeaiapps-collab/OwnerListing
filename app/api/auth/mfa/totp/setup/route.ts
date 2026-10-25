import { NextResponse } from "next/server";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { startTotp } from "../../../../../../src/server/mfa";
import { getMfaDeps, getSessionState, mfaRequiredResponse } from "../../../../../../src/server/mfa-context";
import { withApi } from "../../../../../../src/server/api/with-api";

/** Starts authenticator set-up. Returns the secret and otpauth address once; the secret is stored sealed and never shown again. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const s = await getSessionState(req);
  if (!s) return unauthenticated();
  if (s.mfa.enrolled && !s.mfa.satisfied) return mfaRequiredResponse();
  const r = await startTotp(await getMfaDeps(), s.actor.userId);
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : failure(r);
}

export const POST = withApi(handlePost);
