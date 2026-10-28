import { NextResponse } from "next/server";
import { clientIp } from "../../../../../../src/server/client-ip";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { sendSignInSms } from "../../../../../../src/server/mfa";
import { getMfaDeps, getSessionState } from "../../../../../../src/server/mfa-context";
import { withApi } from "../../../../../../src/server/api/with-api";

/** Texts a sign-in code to the account's confirmed mobile number. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const s = await getSessionState(req);
  if (!s) return unauthenticated();
  const r = await sendSignInSms(await getMfaDeps(), s.actor.userId, clientIp(req));
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const POST = withApi(handlePost);
