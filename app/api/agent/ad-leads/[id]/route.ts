import { NextResponse } from "next/server";
import { isLeadStatus } from "../../../../../src/domain/ad-leads";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { unauthenticated } from "../../../../../src/server/http";
import { setAgentLeadStatus } from "../../../../../src/server/ad-lead-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** {status, reason?}: an agent moves one of their own leads along. A lead that is not theirs answers 404. */
async function handlePost(req: Request, ctx: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "agent") return NextResponse.json({ error: "Only agents have ad leads." }, { status: 403 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { status?: unknown; reason?: unknown };
  if (!isLeadStatus(body.status)) return NextResponse.json({ error: "Unknown status." }, { status: 400 });
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
  const r = await setAgentLeadStatus(getDb(), actor.userId, id, body.status, reason || null, new Date().toISOString());
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.error === "Lead not found." ? 404 : 400 });
  return NextResponse.json({ ok: true });
}

export const POST = withApi(handlePost);
