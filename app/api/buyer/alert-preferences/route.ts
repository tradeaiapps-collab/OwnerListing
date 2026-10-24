import { NextResponse } from "next/server";
import { parseAlertConsentInput, setAlertConsent } from "../../../../src/domain/saved-search-service";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";
import { getSavedSearchRepo } from "../../../../src/server/saved-search-context";

/** The signed-in user's alert consent per channel. */
export async function GET(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json({ preferences: await getSavedSearchRepo().listPreferences(actor.userId) });
}

/** Body: { channel: "email" | "sms", consent: boolean }. true opts in; false unsubscribes. */
export async function PUT(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const parsed = parseAlertConsentInput(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  const preferences = await setAlertConsent(getSavedSearchRepo(), actor.userId, parsed.value, new Date().toISOString());
  return NextResponse.json({ preferences });
}
