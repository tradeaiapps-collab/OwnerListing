import { NextResponse } from "next/server";
import { USAGE_RIGHTS_TEXT } from "../../../../../src/domain/contractor-trust";
import { assignmentAccessPg, quotesForAssignmentPg, reviewForAssignmentPg } from "../../../../../src/server/contractor-trust-db";
import { err, ID_RE, sessionActor } from "../../../../../src/server/contractor-trust-route";
import { getDb } from "../../../../../src/server/context";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Job details for a party to the job: where it is (full address only once accepted), usage-rights status, quotes and the review. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await sessionActor(req);
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!ID_RE.test(id)) return err(404, "Not found.");
  const db = getDb();
  const access = await assignmentAccessPg(db, id, actor.userId);
  if (!access) return err(404, "Not found.");
  const [quotes, review] = await Promise.all([quotesForAssignmentPg(db, id), reviewForAssignmentPg(db, id)]);
  return NextResponse.json({ job: access, quotes, review: review ?? null, usageRightsText: USAGE_RIGHTS_TEXT }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
