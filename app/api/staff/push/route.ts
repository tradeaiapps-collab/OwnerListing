import { NextResponse } from "next/server";
import { summarizeEngagement } from "../../../../src/domain/push";
import { getDb } from "../../../../src/server/context";
import { engagementPg } from "../../../../src/server/push-db";
import { fail, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Push engagement for ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: last 30 days; to is inclusive): sent, failed, opened, dismissed, by platform, topic and Elena personalisation. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  const q = new URL(req.url).searchParams;
  const toDay = q.get("to"), fromDay = q.get("from");
  if ((toDay && !DATE.test(toDay)) || (fromDay && !DATE.test(fromDay))) return fail(400, "Dates are YYYY-MM-DD.");
  const end = toDay ? new Date(`${toDay}T00:00:00Z`) : new Date();
  const to = toDay ? new Date(end.getTime() + 86_400_000) : end;
  const from = fromDay ? new Date(`${fromDay}T00:00:00Z`) : new Date(to.getTime() - 30 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to || to.getTime() - from.getTime() > 366 * 86_400_000) return fail(400, "Pick a range of up to a year.");
  const engagement = summarizeEngagement(await engagementPg(getDb(), from.toISOString(), to.toISOString()));
  return NextResponse.json({ range: { from: from.toISOString(), to: to.toISOString() }, engagement }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
