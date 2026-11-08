import { NextResponse } from "next/server";
import { FOLLOWUP_MODES, isUuid, parseSpendInput, type FollowupMode } from "../../../../../src/domain/ad-leads";
import { staffCan } from "../../../../../src/domain/staff-access";
import { getDb, getStaff } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { getSource, recordSpend, rotateGoogleKey, updateSource } from "../../../../../src/server/ad-lead-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const NOT_FOUND = () => NextResponse.json({ error: "Source not found." }, { status: 404 });

/** Actions: pause | resume | followup {mode} | agent {agentId|null} | rotate_key (Google, shown once) | spend {rows:[{day, spend}]}. */
async function handlePost(req: Request, ctx: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const staff = await getStaff(req);
  if (!staff) return NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
  if (!staffCan(staff, "ad_leads.manage")) return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  const { id } = await ctx.params;
  const db = getDb();
  const source = await getSource(db, id);
  if (!source) return NOT_FOUND();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const now = new Date().toISOString();
  const done = (r: { ok: true } | { ok: false; error: string }) => (r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: 400 }));
  switch (body["action"]) {
    case "pause": return done(await updateSource(db, staff.id, id, { enabled: false }, now));
    case "resume": return done(await updateSource(db, staff.id, id, { enabled: true }, now));
    case "followup":
      if (!FOLLOWUP_MODES.includes(body["mode"] as FollowupMode)) return NextResponse.json({ error: "Follow-up must be off, contact details or property matches." }, { status: 400 });
      return done(await updateSource(db, staff.id, id, { followupMode: body["mode"] as FollowupMode }, now));
    case "agent":
      if (body["agentId"] !== null && !isUuid(body["agentId"])) return NextResponse.json({ error: "Pick an agent." }, { status: 400 });
      return done(await updateSource(db, staff.id, id, { defaultAgentId: body["agentId"] as string | null }, now));
    case "rotate_key": {
      if (source.provider !== "google") return NextResponse.json({ error: "Only Google sources have a key." }, { status: 400 });
      const key = await rotateGoogleKey(db, staff.id, id, now);
      return key ? NextResponse.json({ webhookKey: key }, { headers: { "cache-control": "no-store" } }) : NOT_FOUND();
    }
    case "spend": {
      const parsed = parseSpendInput(body);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      return (await recordSpend(db, staff.id, id, parsed.value.rows, now)) ? NextResponse.json({ ok: true }) : NOT_FOUND();
    }
    default: return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
}

export const POST = withApi(handlePost);
