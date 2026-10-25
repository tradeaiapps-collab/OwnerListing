import { NextResponse } from "next/server";
import { nextVerificationStep, verificationSteps } from "../../../../src/domain/buyer";
import { getActor, getDb } from "../../../../src/server/context";
import { unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in buyer's verification progress. Status only: no phone number, document or image details. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "buyer") return NextResponse.json({ error: "Buyers only." }, { status: 403 });
  const { rows } = await getDb().query(
    `SELECT email_verified_at IS NOT NULL AS email, phone_verified_at IS NOT NULL AS phone, id_verified_at IS NOT NULL AS id
       FROM buyer_verification WHERE user_id = $1`, [actor.userId]);
  const r = rows[0];
  const v = { emailVerified: r?.["email"] === true, phoneVerified: r?.["phone"] === true, idVerified: r?.["id"] === true };
  return NextResponse.json({ steps: verificationSteps(v), next: nextVerificationStep(v) });
}

export const GET = withApi(handleGet);
