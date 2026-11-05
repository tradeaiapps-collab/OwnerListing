import { after, NextResponse } from "next/server";
import { getDb } from "../../../../../../src/server/context";
import { getJob, runJob } from "../../../../../../src/server/listing-bulk-db";
import { bulkIo } from "../../../../../../src/server/listing-bulk-io";
import { fail, staffGate } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Progress of a bulk run. A run whose worker stopped is picked up again here (the claim is atomic, so this is safe to poll). */
async function handleGet(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "listing.bulk");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  const db = getDb();
  const job = await getJob(db, id);
  if (!job) return fail(404, "Bulk run not found.");
  if (job.status === "queued" || job.status === "running") after(() => runJob(db, bulkIo(), id));
  return NextResponse.json({ job }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
