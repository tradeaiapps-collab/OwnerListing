import { NextResponse } from "next/server";
import { parseVerification, todayUtc, verificationState } from "../../../../src/domain/contractor-trust";
import { effectiveDates } from "../../../../src/domain/contractor-certificates";
import { listCertificatesPg, certDates } from "../../../../src/server/contractor-certificates-db";
import { getStandingPg, getVerificationPg, reviewsForContractorPg, submitVerificationPg } from "../../../../src/server/contractor-trust-db";
import { err, guardText, readBody, sessionActor } from "../../../../src/server/contractor-trust-route";
import { getDb } from "../../../../src/server/context";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in contractor's own verification details, badge state, standing and reviews (to reply to). */
async function handleGet(req: Request) {
  const actor = await sessionActor(req, { contractor: true });
  if (actor instanceof NextResponse) return actor;
  const db = getDb();
  const [verification, standing, reviews, certificates] = await Promise.all([getVerificationPg(db, actor.userId), getStandingPg(db, actor.userId), reviewsForContractorPg(db, actor.userId), listCertificatesPg(db, actor.userId)]);
  const effective = verification ? effectiveDates(verification, certDates(certificates)) : undefined;
  return NextResponse.json({ verification: verification ?? null, state: verificationState(effective, todayUtc()), standing, reviews, certificates }, { headers: { "cache-control": "no-store" } });
}

/** Submit or re-submit licence, insurance and ABN. Staff check them; any change puts the badge back to pending. */
async function handlePut(req: Request) {
  const actor = await sessionActor(req, { contractor: true, write: true });
  if (actor instanceof NextResponse) return actor;
  const parsed = parseVerification(await readBody(req), todayUtc());
  if (!parsed.ok) return err(400, parsed.message);
  const v = parsed.value;
  const g = await guardText(actor.userId, "contractor_verification", { businessName: v.businessName, insurer: v.insurer }, { source: "profile" });
  if ("response" in g) return g.response;
  if (!(await submitVerificationPg(getDb(), actor.userId, v))) return err(403, "This account cannot submit verification details.");
  await g.after(actor.userId);
  return NextResponse.json({ ok: true });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
