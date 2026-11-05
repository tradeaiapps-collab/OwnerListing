import { NextResponse } from "next/server";
import { isPortal } from "../../../../../src/domain/syndication";
import { getDb } from "../../../../../src/server/context";
import { fail, readJsonObject, staffGate, UUID_RE } from "../../../../../src/server/staff-route";
import { retrySync, syncOne, syndicationDeps } from "../../../../../src/server/syndication-db";
import { withApi } from "../../../../../src/server/api/with-api";

/** Body: { listingId, portal }. Puts a failed sync back in the queue and tries it now. */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "syndication.manage");
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  if (!body || typeof body["listingId"] !== "string" || !UUID_RE.test(body["listingId"]) || !isPortal(body["portal"])) return fail(400, "Send listingId and portal.");
  const deps = syndicationDeps();
  if (!(await retrySync(getDb(), staff, body["listingId"], body["portal"], deps.now()))) return fail(404, "There is no failed sync to retry.");
  return NextResponse.json({ outcome: await syncOne(getDb(), deps, body["listingId"], body["portal"]) });
}

export const POST = withApi(handlePost);
