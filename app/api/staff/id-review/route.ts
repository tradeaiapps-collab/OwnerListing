import { NextResponse } from "next/server";
import { ID_IMAGES_AVAILABLE } from "../../../../src/domain/staff-admin";
import { getDb } from "../../../../src/server/context";
import { listIdQueue } from "../../../../src/server/staff-admin-db";
import { staffAudit, staffGate } from "../../../../src/server/staff-route";

/** Identity submissions waiting for review. Checklist data only: no document images are returned. */
export async function GET(req: Request) {
  const staff = await staffGate(req, "identity.review");
  if (staff instanceof NextResponse) return staff;
  const submissions = await listIdQueue(getDb());
  await staffAudit(staff, "staff_session", staff.id, "staff.id_queue_viewed", { returned: submissions.length });
  return NextResponse.json({ submissions, imagesAvailable: ID_IMAGES_AVAILABLE, me: staff.id });
}
