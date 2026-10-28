import { NextResponse } from "next/server";
import { getDb } from "../../../../src/server/context";
import { listIdQueue } from "../../../../src/server/staff-admin-db";
import { staffAudit, staffGate } from "../../../../src/server/staff-route";
import { idImagesAvailable } from "../../../../src/server/verification-context";
import { withApi } from "../../../../src/server/api/with-api";

/** Identity submissions waiting for review. No images or storage keys: the claiming reviewer opens images through the audited image route. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "identity.review");
  if (staff instanceof NextResponse) return staff;
  const submissions = await listIdQueue(getDb());
  await staffAudit(staff, "staff_session", staff.id, "staff.id_queue_viewed", { returned: submissions.length });
  return NextResponse.json({ submissions, imagesAvailable: idImagesAvailable(), me: staff.id });
}

export const GET = withApi(handleGet);
