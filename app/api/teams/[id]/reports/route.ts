import { NextResponse } from "next/server";
import { getActor } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";
import { reportResponse } from "../../../../../src/server/agent-report-response";
import { getTeamAnalyticsDeps } from "../../../../../src/server/team-analytics-db";
import { parseTeamFilter, runTeamReport, teamDefinitionFromQuery } from "../../../../../src/domain/team-reports";

type Ctx = { params: Promise<{ id: string }> };

/**
 * A team report for the team's managers: ?template=&metrics=a,b&groupBy=none|listing|month&days=|from=&to=&agents=id,id&propertyType=house&format=json|csv|xlsx|pdf.
 * Two agents in `agents` also returns an agent-against-agent comparison.
 */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const q = new URL(req.url).searchParams;
  const def = teamDefinitionFromQuery(q);
  if (!def.ok) return failure(def);
  const r = await runTeamReport(getTeamAnalyticsDeps(), actor, id, members => {
    const f = parseTeamFilter(q.get("agents"), q.get("propertyType"), members);
    return f.ok ? { ok: true, value: { definition: def.value, filter: f.value } } : f;
  });
  if (!r.ok) return failure(r);
  const format = q.get("format");
  if (format === null || format === "json") return NextResponse.json(r.value, { headers: { "cache-control": "no-store" } });
  return reportResponse(r.value.report, r.value.insights, format);
}

export const GET = withApi(handleGet);
export const dynamic = "force-dynamic";
