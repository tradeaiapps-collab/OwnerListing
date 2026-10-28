import { NextResponse } from "next/server";
import { clientIp } from "../../../../../src/server/client-ip";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { verifySecondFactor } from "../../../../../src/server/mfa";
import { getMfaDeps, getSessionState, markMfaPassed } from "../../../../../src/server/mfa-context";
import { withApi } from "../../../../../src/server/api/with-api";

/** Body: { method: "totp" | "sms" | "recovery", code }. Marks this session as having passed MFA. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const s = await getSessionState(req);
  if (!s) return unauthenticated();
  const r = await verifySecondFactor(await getMfaDeps(), s.actor.userId, clientIp(req), await req.json().catch(() => null));
  return r.ok ? markMfaPassed(NextResponse.json({ verified: true, ...r.value }), s) : failure(r);
}

export const POST = withApi(handlePost);
