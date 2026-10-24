import { NextResponse } from "next/server";
import { ID_IMAGE_CONSENT_TEXT, ID_IMAGE_CONSENT_VERSION } from "../../../../../src/domain/id-image";
import { SMS_CONSENT_TEXT } from "../../../../../src/domain/phone-verification";
import { getActor } from "../../../../../src/server/context";
import { unauthenticated } from "../../../../../src/server/http";
import { verificationAvailability } from "../../../../../src/server/verification-context";

/** Which verification steps can be offered now (a port that is not configured reports false), and the SMS and ID-photo consent wording. */
export async function GET(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "buyer") return NextResponse.json({ error: "Buyers only." }, { status: 403 });
  return NextResponse.json({ available: verificationAvailability(), smsConsentText: SMS_CONSENT_TEXT, idImageConsent: { text: ID_IMAGE_CONSENT_TEXT, version: ID_IMAGE_CONSENT_VERSION } });
}
