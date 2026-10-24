import { NextResponse } from "next/server";
import { getActor } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { clientIp } from "../../../../../../src/server/client-ip";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { sendPhoneCode } from "../../../../../../src/server/phone-verification";
import { getPhoneDeps } from "../../../../../../src/server/verification-context";

/** Body: { phone, consent: true }. Buyers only. Texts a 6-digit code once the Spam Act consent box is ticked. */
export async function POST(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "buyer") return NextResponse.json({ error: "Buyers only." }, { status: 403 });
  const r = await sendPhoneCode(await getPhoneDeps(), actor.userId, clientIp(req), await req.json().catch(() => null));
  return r.ok ? NextResponse.json(r.value) : failure(r);
}
