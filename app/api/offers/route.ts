import { NextResponse } from "next/server";
import { awaiting } from "../../../src/domain/offer-counter";
import { getActor, getDb, getDeps } from "../../../src/server/context";
import { failure, unauthenticated } from "../../../src/server/http";
import { expireCountersPg, offersForBuyerPg } from "../../../src/server/offer-counter-db";
import { withApi } from "../../../src/server/api/with-api";

/** The signed-in buyer's own offers. Only buyers; everyone else gets 404. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "buyer") return failure({ ok: false, code: "not_found", message: "Not found." });
  const db = getDb();
  await expireCountersPg(db, getDeps().now(), { buyerUserId: actor.userId });
  const offers = await offersForBuyerPg(db, actor.userId);
  return NextResponse.json({ offers: offers.map(o => ({ ...o, awaiting: awaiting(o.status) })) });
}

export const GET = withApi(handleGet);
