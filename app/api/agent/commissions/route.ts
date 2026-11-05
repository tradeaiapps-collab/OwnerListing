import { NextResponse } from "next/server";
import { agentTotals, buildStatement, elenaCommissionSummary, forecastEarnings, statementCsv } from "../../../../src/domain/commission";
import { agentCommissions, agentDisplayName } from "../../../../src/server/commission-db";
import { getActor, getDb } from "../../../../src/server/context";
import { unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * The signed-in agent's own commissions: deals, payments, totals, a monthly statement (?month=YYYY-MM, CSV with &format=csv),
 * and Elena's summary and earnings outlook. The agent id comes from the session, never the request. Read only.
 */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "agent") return NextResponse.json({ error: "Commissions are for agents." }, { status: 403 });
  const url = new URL(req.url);
  const today = new Date().toISOString().slice(0, 10);
  const month = url.searchParams.get("month") ?? today.slice(0, 7);
  if (!MONTH_RE.test(month)) return NextResponse.json({ error: "The month must look like 2026-11." }, { status: 400 });
  const db = getDb();
  const { deals, payouts } = await agentCommissions(db, actor.userId);
  const statement = buildStatement(deals, payouts, month);
  if (url.searchParams.get("format") === "csv") {
    return new NextResponse(statementCsv(statement), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="commission-statement-${month}.csv"`, "cache-control": "no-store" }
    });
  }
  const totals = agentTotals(deals, payouts, today);
  const forecast = forecastEarnings(deals, payouts, today);
  const first = (await agentDisplayName(db, actor.userId)).split(/\s+/)[0] ?? "";
  return NextResponse.json({ deals, payouts, totals, statement, forecast, elena: elenaCommissionSummary(first, totals, forecast) }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
