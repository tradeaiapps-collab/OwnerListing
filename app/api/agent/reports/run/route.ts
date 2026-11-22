import { getActor } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";
import { getReportDeps } from "../../../../../src/server/agent-reports-db";
import { definitionFromQuery, runReport } from "../../../../../src/domain/agent-reports";
import { reportResponse } from "../../../../../src/server/agent-report-response";

/** Run a report without saving it: ?template=&metrics=a,b&groupBy=&days=|from=&to=&format=json|csv|xlsx|pdf. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const params = new URL(req.url).searchParams;
  const def = definitionFromQuery(params);
  if (!def.ok) return failure(def);
  const r = await runReport(getReportDeps(), actor, def.value);
  return r.ok ? reportResponse(r.value.report, r.value.insights, params.get("format")) : failure(r);
}

export const GET = withApi(handleGet);
export const dynamic = "force-dynamic";
