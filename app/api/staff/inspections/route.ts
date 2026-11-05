import { NextResponse } from "next/server";
import { reviewInspector, type BookingStatus, type InspectorStatus } from "../../../../src/domain/inspection-marketplace";
import { failure } from "../../../../src/server/http";
import { bookingIds, getBookingRepo } from "../../../../src/server/inspection-marketplace-db";
import { fail, readJsonObject, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

const BOOKING = ["pending_inspector_response", "scheduled", "completed", "cancelled"];
const INSPECTOR = ["pending", "approved", "rejected", "suspended"];

/** Inspector applications and every inspection request. Optional ?inspectors=<status>&bookings=<status> filters. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "user.manage");
  if (staff instanceof NextResponse) return staff;
  const q = new URL(req.url).searchParams;
  const is = q.get("inspectors"), bs = q.get("bookings");
  if ((is && !INSPECTOR.includes(is)) || (bs && !BOOKING.includes(bs))) return fail(400, "Unknown filter.");
  const repo = getBookingRepo();
  const [inspectors, bookings] = await Promise.all([repo.listProfiles((is as InspectorStatus | null) ?? undefined), repo.listBookings((bs as BookingStatus | null) ?? undefined)]);
  return NextResponse.json({ inspectors, bookings }, { headers: { "cache-control": "no-store" } });
}

/** Body: { userId, decision: "approved" | "rejected" | "suspended", note? }. A rejection or suspension needs a reason. Audited. */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "user.manage");
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send a JSON object.");
  const r = await reviewInspector(getBookingRepo(), staff.id, body["userId"], body["decision"], body["note"], bookingIds);
  return r.ok ? NextResponse.json({ ok: true }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
