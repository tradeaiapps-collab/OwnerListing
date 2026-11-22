import { NextResponse } from "next/server";
import { ANALYTICS_TIME_ZONE } from "../../../../src/domain/admin-analytics";
import { computeMetrics, DEFAULT_PERFORMANCE_DAYS, monthComparison, periodRange, suggestions } from "../../../../src/domain/agent-performance";
import { shiftDays } from "../../../../src/domain/agent-benchmark";
import { localDateInZone } from "../../../../src/domain/timezone";
import { loadPerformanceFacts, recentRatingComments } from "../../../../src/server/agent-performance-db";
import { getActor, getDb } from "../../../../src/server/context";
import { unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in agent's own figures: the last 180 days, this month against last month, recent rating comments and rule-based suggestions. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "agent") return NextResponse.json({ error: "My performance is for agents." }, { status: 403 });
  const today = localDateInZone(new Date().toISOString(), ANALYTICS_TIME_ZONE);
  const range = periodRange(DEFAULT_PERFORMANCE_DAYS, today);
  const from = [range.from, `${shiftDays(`${today.slice(0, 8)}01`, -1).slice(0, 8)}01`].sort()[0]!;
  const db = getDb();
  const [mine, platform] = await Promise.all([loadPerformanceFacts(db, from, today, { agentId: actor.userId }), loadPerformanceFacts(db, range.from, range.to, "all")]);
  const metrics = computeMetrics(mine, range, actor.userId);
  const platformMetrics = computeMetrics(platform, range);
  return NextResponse.json({
    range, metrics, platform: platformMetrics, months: monthComparison(mine, actor.userId, today),
    suggestions: suggestions(metrics, platformMetrics), comments: await recentRatingComments(db, actor.userId), activeListings: mine.agents[0]?.activeListings ?? 0
  }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
export const dynamic = "force-dynamic";
