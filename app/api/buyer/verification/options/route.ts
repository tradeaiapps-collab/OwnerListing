import { NextResponse } from "next/server";
import { readBrand } from "../../../../../src/config/brand";
import { smsConsentText } from "../../../../../src/domain/phone-verification";
import { getActor } from "../../../../../src/server/context";
import { unauthenticated } from "../../../../../src/server/http";
import { verificationAvailability } from "../../../../../src/server/verification-context";

/** Which verification steps can be offered now (a port that is not configured reports false), and the SMS consent wording. */
export async function GET(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "buyer") return NextResponse.json({ error: "Buyers only." }, { status: 403 });
  return NextResponse.json({ available: await verificationAvailability(), smsConsentText: smsConsentText(readBrand().name) });
}
