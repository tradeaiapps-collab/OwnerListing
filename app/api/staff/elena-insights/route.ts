import { NextResponse } from "next/server";
import { ANALYTICS_TIME_ZONE, parseRange } from "../../../../src/domain/admin-analytics";
import { buildInsights } from "../../../../src/domain/admin-elena-insights";
import { localDateInZone } from "../../../../src/domain/timezone";
import { personaById } from "../../../../src/domain/assistant-persona";
import { loadLivePersona } from "../../../../src/server/assistant-persona-db";
import { loadAlertSettings } from "../../../../src/server/alert-config-db";
import { getDb } from "../../../../src/server/context";
import { loadInsightFacts } from "../../../../src/server/admin-elena-insights-db";
import { fail, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** Elena's platform insights for ?from=&to= (default: last 90 days) against the equal period before. Read only; needs the sales report permission. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  const parsed = parseRange(new URL(req.url).searchParams, localDateInZone(new Date().toISOString(), ANALYTICS_TIME_ZONE));
  if (!parsed.ok) return fail(400, parsed.error);
  const db = getDb();
  const config = await loadAlertSettings(db);
  const insights = buildInsights(staff, await loadInsightFacts(db, parsed.range, new Date(), config.agent_unanswered.threshold), config);
  const persona = personaById(await loadLivePersona(db)).name;
  return NextResponse.json({ insights, range: parsed.range, timeZone: ANALYTICS_TIME_ZONE, persona }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
