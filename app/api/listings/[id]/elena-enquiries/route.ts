import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { getSettings, listLogForOwner, parseSettings, saveSettings } from "../../../../../src/server/elena-enquiries-db";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = { ok: false, code: "not_found", message: "Not found." } as const;
const owns = async (listingId: string, userId: string) => (await getDb().query("SELECT 1 FROM property_listing WHERE id = $1::uuid AND owner_user_id = $2::uuid", [listingId, userId])).rows.length === 1;

/** The owner's Elena enquiry settings for this listing and Elena's log (what she answered, handed over or was blocked from sending). Anyone else gets 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID.test(id) || !(await owns(id, actor.userId))) return failure(NOT_FOUND);
  return NextResponse.json({ settings: await getSettings(getDb(), id), log: await listLogForOwner(getDb(), actor.userId, id) });
}

/** Body: { enabled, offerInspections, autoSend } (all booleans). Auto-send is only kept while Elena is on. */
async function handlePut(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID.test(id)) return failure(NOT_FOUND);
  const s = parseSettings(await req.json().catch(() => null));
  if (!s) return failure({ ok: false, code: "invalid", message: "Send enabled, offerInspections and autoSend as true or false." });
  if (!(await saveSettings(getDb(), actor.userId, id, s))) return failure(NOT_FOUND);
  return NextResponse.json({ settings: s });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
