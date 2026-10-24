import { NextResponse } from "next/server";
import { getActor } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { clientIp } from "../../../../../../src/server/client-ip";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { verifyPhoneCode } from "../../../../../../src/server/phone-verification";
import { getPhoneDeps } from "../../../../../../src/server/verification-context";

/** Body: { code }. Buyers only. Sets phone_verified_at only on a correct, unexpired code. */
export async function POST(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "buyer") return NextResponse.json({ error: "Buyers only." }, { status: 403 });
  const r = await verifyPhoneCode(await getPhoneDeps(), actor.userId, clientIp(req), await req.json().catch(() => null));
  return r.ok ? NextResponse.json(r.value) : failure(r);
}
