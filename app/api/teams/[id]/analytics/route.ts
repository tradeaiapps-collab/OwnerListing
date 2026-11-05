import { NextResponse } from "next/server";
import { getActor } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";
import { getTeamAnalyticsDeps } from "../../../../../src/server/team-analytics-db";
import { analyticsPeriod, teamAnalytics } from "../../../../../src/domain/team-analytics";

type Ctx = { params: Promise<{ id: string }> };

/** Analytics for one team, for its managers only: ?days=7|30|90|365 (default 90) or ?from=&to=. Compared with the equal period before. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const period = analyticsPeriod(new URL(req.url).searchParams);
  if (!period.ok) return failure(period);
  const r = await teamAnalytics(getTeamAnalyticsDeps(), actor, id, period.value);
  return r.ok ? NextResponse.json({ analytics: r.value }, { headers: { "cache-control": "no-store" } }) : failure(r);
}

export const GET = withApi(handleGet);
export const dynamic = "force-dynamic";
