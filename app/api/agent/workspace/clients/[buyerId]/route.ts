import { NextResponse } from "next/server";
import { getActor } from "../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { withApi } from "../../../../../../src/server/api/with-api";
import { getWorkspaceDeps } from "../../../../../../src/server/agent-workspace-db";
import { addClientNote, clientDetail } from "../../../../../../src/domain/agent-workspace";

type Ctx = { params: Promise<{ buyerId: string }> };

/** One client's lead card, private log and summary. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await clientDetail(getWorkspaceDeps(), actor, (await params).buyerId);
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : failure(r);
}

/** Log a note, call, email, meeting or preference: { kind, body }. */
async function handlePost(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await addClientNote(getWorkspaceDeps(), actor, (await params).buyerId, await req.json().catch(() => null));
  return r.ok ? NextResponse.json({ ok: true }, { status: 201 }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
