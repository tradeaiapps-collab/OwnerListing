import { NextResponse } from "next/server";
import { agentLabel } from "../../../../src/domain/admin-elena-insights";
import { getDb } from "../../../../src/server/context";
import { emergencyOutboxPg, staffRequestsPg } from "../../../../src/server/emergency-db";
import { staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Urgent requests and the email and text log for them. Shows the trade, area, status, how many contractors were asked, reached, declined and accepted.
 * Never the street address, a phone number or an email address. Requester names follow the staff member's personal-data permission.
 */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "report.operations");
  if (staff instanceof NextResponse) return staff;
  const db = getDb();
  const [requests, outbox] = await Promise.all([staffRequestsPg(db, 100), emergencyOutboxPg(db, 100)]);
  return NextResponse.json({
    requests: requests.map((r, i) => ({ ...r, requesterName: undefined, requester: agentLabel(staff, r.requesterName, i).replace(/^Agent (\d+)$/, "Requester $1") })),
    outbox
  }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
export const dynamic = "force-dynamic";
