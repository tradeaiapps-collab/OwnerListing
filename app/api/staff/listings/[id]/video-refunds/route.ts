import { NextResponse } from "next/server";
import { refundTrail } from "../../../../../../src/domain/listing-video";
import { getVideoRepo } from "../../../../../../src/server/listing-video-db";
import { fail, staffGate, UUID_RE } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Refund audit trail for a listing's tour videos (read only): reason, status, Stripe refund id and timestamps. Needs the listing moderation permission. */
async function handleGet(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "listing.moderate");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Listing not found.");
  const r = await refundTrail(getVideoRepo(), id);
  if (!r.ok) return fail(400, r.message);
  return NextResponse.json(r.value, { headers: { "cache-control": "no-store" } });
}
export const GET = withApi(handleGet);
