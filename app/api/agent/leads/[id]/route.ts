import { NextResponse } from "next/server";
import { agentAddNote, agentLeadDetail, agentLogContact, agentSetResult } from "../../../../../src/domain/lead-service";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { getLeadDeps } from "../../../../../src/server/lead-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** One lead with its notes and what the lead told Elena. Only the assigned agent; anyone else gets 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await agentLeadDetail(await getLeadDeps(), actor, (await params).id);
  return r.ok ? NextResponse.json({ lead: r.value }, { headers: { "cache-control": "no-store" } }) : failure(r);
}

/** Body: { "action": "contact" } logs first contact; { "action": "note", "body": "..." }; { "action": "result", "result": "converted"|"lost"|"unresponsive", "note"? }. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const d = await getLeadDeps();
  const r = b?.["action"] === "contact" ? await agentLogContact(d, actor, id)
    : b?.["action"] === "note" ? await agentAddNote(d, actor, id, b["body"])
    : b?.["action"] === "result" ? await agentSetResult(d, actor, id, b)
    : ({ ok: false, code: "invalid", message: "Unknown action." } as const);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
