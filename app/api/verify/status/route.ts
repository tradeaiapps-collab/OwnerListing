import { NextResponse } from "next/server";
import { canContactSeller, nextVerificationStep } from "../../../../src/domain/buyer";
import { getActor, getDb } from "../../../../src/server/context";
import { getBuyerVerification } from "../../../../src/server/enquiry-db";
import { unauthenticated } from "../../../../src/server/http";

export async function GET(req: Request) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const v = await getBuyerVerification(getDb(), actor.userId);
  return NextResponse.json({ ...v, canContactSeller: canContactSeller(v), nextStep: nextVerificationStep(v) });
}
