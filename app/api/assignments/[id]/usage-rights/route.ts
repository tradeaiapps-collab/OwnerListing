import { NextResponse } from "next/server";
import { confirmUsageRightsPg } from "../../../../../src/server/contractor-trust-db";
import { err, ID_RE, readBody, sessionActor } from "../../../../../src/server/contractor-trust-route";
import { getDb } from "../../../../../src/server/context";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** The photographer confirms they own or may licence the photos. Body: { "confirm": true }. Stored once with the job; photo upload needs it. */
async function handlePost(req: Request, { params }: Ctx) {
  const actor = await sessionActor(req, { contractor: true, write: true });
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!ID_RE.test(id)) return err(404, "Not found.");
  const body = (await readBody(req)) as Record<string, unknown> | null;
  if (body?.["confirm"] !== true) return err(400, "Tick the box to confirm you have the rights to the photos.");
  if (!(await confirmUsageRightsPg(getDb(), actor.userId, id))) return err(409, "This job is not an accepted photography job of yours, or you have already confirmed.");
  return NextResponse.json({ ok: true });
}

export const POST = withApi(handlePost);
