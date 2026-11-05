import { NextResponse } from "next/server";
import { addLeadNote, getAgentLead, scheduleFollowup, setLeadStatus } from "../../../../../src/server/agent-lead-db";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const NOT_AGENT = () => NextResponse.json({ error: "Only agents have buyer leads." }, { status: 403 });

/** One lead with its notes and history. A lead that is not the signed-in agent's own answers 404. */
async function handleGet(req: Request, ctx: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "agent") return NOT_AGENT();
  const lead = await getAgentLead(getDb(), actor.userId, (await ctx.params).id, new Date().toISOString());
  return lead ? NextResponse.json({ lead }, { headers: { "cache-control": "no-store" } }) : NextResponse.json({ error: "Lead not found." }, { status: 404 });
}

/** {action:"note",text} | {action:"followup",days:1|2|3|7|14|null,note?} | {action:"status",status,reason?,note?}. */
async function handlePost(req: Request, ctx: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "agent") return NOT_AGENT();
  const { id } = await ctx.params;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const db = getDb();
  const now = new Date().toISOString();
  const r = b["action"] === "note" ? await addLeadNote(db, actor.userId, id, b["text"], now)
    : b["action"] === "followup" ? await scheduleFollowup(db, actor.userId, id, b["days"], b["note"], now)
    : b["action"] === "status" ? await setLeadStatus(db, actor.userId, id, b["status"], b["reason"], b["note"])
    : undefined;
  if (!r) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.notFound ? 404 : 400 });
  return NextResponse.json({ ok: true, result: r.value });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
