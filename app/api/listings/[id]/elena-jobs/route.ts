import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { dispatchOpenSlots, getSettings, listJobsForOwner, parseSettings, saveSettings } from "../../../../../src/server/elena-jobs-db";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = { ok: false, code: "not_found", message: "Not found." } as const;

/** The owner's Elena job settings for this listing, and every job with Elena's log. Anyone else gets 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID.test(id)) return failure(NOT_FOUND);
  const jobs = await listJobsForOwner(getDb(), actor.userId, id);
  const owns = (await getDb().query("SELECT 1 FROM property_listing WHERE id = $1::uuid AND owner_user_id = $2::uuid", [id, actor.userId])).rows.length === 1;
  if (!owns) return failure(NOT_FOUND);
  return NextResponse.json({ settings: await getSettings(getDb(), id), jobs });
}

/** Body: { handleJobs, autoReply, hideNewFiles } (all booleans). Turning "let Elena handle it" on asks nearby contractors straight away. */
async function handlePut(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID.test(id)) return failure(NOT_FOUND);
  const s = parseSettings(await req.json().catch(() => null));
  if (!s) return failure({ ok: false, code: "invalid", message: "Send handleJobs, autoReply and hideNewFiles as true or false." });
  if (!(await saveSettings(getDb(), actor.userId, id, s))) return failure(NOT_FOUND);
  if (s.handleJobs) {
    const l = (await getDb().query("SELECT id, owner_user_id, suburb, postcode FROM property_listing WHERE id = $1::uuid", [id])).rows;
    await dispatchOpenSlots(getDb(), l).catch(() => 0);
  }
  return NextResponse.json({ settings: s });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
