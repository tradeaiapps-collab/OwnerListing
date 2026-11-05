import { NextResponse } from "next/server";
import { getActor } from "../../../../src/server/context";
import { unauthenticated } from "../../../../src/server/http";
import { forecastResponse } from "../../../../src/server/market-forecast-response";
import { withApi } from "../../../../src/server/api/with-api";

/** The same market forecast staff see, for agents: ?area=&type=. Area-level aggregates only. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "agent") return NextResponse.json({ error: "Market forecasts are for agents." }, { status: 403 });
  return forecastResponse(req);
}

export const GET = withApi(handleGet);
export const dynamic = "force-dynamic";
