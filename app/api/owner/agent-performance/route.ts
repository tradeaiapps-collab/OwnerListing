import { NextResponse } from "next/server";
import { ANALYTICS_TIME_ZONE } from "../../../../src/domain/admin-analytics";
import { buildOwnerRows, filterAgents, parseCompareIds, parseOwnerFilter, parsePerformanceDays, periodRange } from "../../../../src/domain/agent-performance";
import { SPECIALTIES } from "../../../../src/domain/agent-marketplace";
import { localDateInZone } from "../../../../src/domain/timezone";
import { listFavorites, loadPerformanceFacts, recentRatingComments } from "../../../../src/server/agent-performance-db";
import { getActor, getDb } from "../../../../src/server/context";
import { unauthenticated } from "../../../../src/server/http";
import { UUID_RE } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Marketplace agents with their performance, for owners choosing an agent. ?days=30|90|180|365 (default 180), ?q= &area= &specialty= &available=1,
 * ?compare=<up to 3 agent ids> adds those agents' recent rating comments (rating, comment and month only; no buyer is named).
 */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "owner") return NextResponse.json({ error: "Agent performance is for owners." }, { status: 403 });
  const q = new URL(req.url).searchParams;
  const days = parsePerformanceDays(q.get("days"));
  if (days === undefined) return NextResponse.json({ error: "Period must be 30, 90, 180 or 365 days." }, { status: 400 });
  const compare = parseCompareIds(q.get("compare"), s => UUID_RE.test(s));
  if (compare === undefined) return NextResponse.json({ error: "Compare up to 3 agents." }, { status: 400 });
  const today = localDateInZone(new Date().toISOString(), ANALYTICS_TIME_ZONE);
  const range = periodRange(days, today);
  const db = getDb();
  const [facts, favorites] = await Promise.all([loadPerformanceFacts(db, range.from, range.to, "listed"), listFavorites(db, actor.userId)]);
  const all = buildOwnerRows(facts, range, favorites);
  const agents = filterAgents(all, parseOwnerFilter(q));
  const picked = all.filter(a => compare.includes(a.agentId));
  const comments = Object.fromEntries(await Promise.all(picked.map(async a => [a.agentId, await recentRatingComments(db, a.agentId)] as const)));
  return NextResponse.json({ range, days, agents, compare: picked, comments, specialties: SPECIALTIES }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
export const dynamic = "force-dynamic";
