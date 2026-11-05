import { NextResponse } from "next/server";
import { getDb } from "../../../../../../src/server/context";
import { exportListingsCsv, resolveSelection } from "../../../../../../src/server/listing-bulk-db";
import { readSelection } from "../../../../../../src/server/listing-bulk-selection";
import { fail, readJsonObject, staffGate } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

/** Body { ids | filter }: a CSV of up to 500 listings (no owner details). The export is logged. */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "listing.bulk");
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  const sel = body ? readSelection(body) : null;
  if (!sel) return fail(400, "Select listings first.");
  const db = getDb();
  const picked = await resolveSelection(db, sel);
  if ("error" in picked) return fail(400, picked.error);
  const csv = await exportListingsCsv(db, { id: staff.id, role: staff.role }, picked.ids);
  return new NextResponse(csv, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="listings-${new Date().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" }
  });
}

export const POST = withApi(handlePost);
