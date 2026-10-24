import { NextResponse } from "next/server";
import { myOffers, parseOfferInput, submitOffer } from "../../../src/domain/offer-service";
import { getActor, getOfferDeps } from "../../../src/server/context";
import { failure, unauthenticated } from "../../../src/server/http";

/** Offers the user made and offers on their own listings. */
export async function GET(req: Request) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json({ items: await myOffers(getOfferDeps(), actor) });
}

/** Submits a formal offer using a single-use link from the enquiry chat. */
export async function POST(req: Request) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const input = parseOfferInput(await req.json().catch(() => null));
  if (!input.ok) return failure(input);
  const r = await submitOffer(getOfferDeps(), actor, input.value);
  return r.ok ? NextResponse.json({ offer: r.value }, { status: 201 }) : failure(r);
}
