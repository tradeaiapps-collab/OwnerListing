import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { staffCan } from "../../../../../src/domain/staff-access";
import { getDb, getStaff } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { appendAuditPg } from "../../../../../src/server/db";
import { disableOutbound, enableOutbound, getOutbound, recentDeliveries } from "../../../../../src/server/crm-sync-db";
import { getConnection, recentRuns, rotatePushToken, runConnection, setConnectionEnabled } from "../../../../../src/server/property-feed-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const NEED_STAFF = () => NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
const NOT_ALLOWED = () => NextResponse.json({ error: "Not allowed." }, { status: 403 });
const NOT_FOUND = () => NextResponse.json({ error: "Connection not found." }, { status: 404 });
const NO_STORE = { "cache-control": "no-store" };

/** One connection and its last 20 runs. */
async function handleGet(req: Request, ctx: Ctx) {
  const staff = await getStaff(req);
  if (!staff) return NEED_STAFF();
  if (!staffCan(staff, "feeds.manage")) return NOT_ALLOWED();
  const { id } = await ctx.params;
  const conn = await getConnection(getDb(), id);
  if (!conn) return NOT_FOUND();
  return NextResponse.json({ connection: conn, runs: await recentRuns(getDb(), id), outbound: await getOutbound(getDb(), id), deliveries: await recentDeliveries(getDb(), id) }, { headers: NO_STORE });
}

/** Actions: {action:"run"} runs it now, {action:"pause"|"resume"}, {action:"enable_outbound",url}|{action:"disable_outbound"} control status sync to the CRM, {action:"rotate_token"} issues a new CRM push token (shown once). */
async function handlePost(req: Request, ctx: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const staff = await getStaff(req);
  if (!staff) return NEED_STAFF();
  if (!staffCan(staff, "feeds.manage")) return NOT_ALLOWED();
  const { id } = await ctx.params;
  const db = getDb();
  const conn = await getConnection(db, id);
  if (!conn) return NOT_FOUND();
  const body = (await req.json().catch(() => ({}))) as { action?: unknown; url?: unknown };
  const now = new Date().toISOString();
  switch (body.action) {
    case "run": {
      if (!conn.enabled) return NextResponse.json({ error: "Resume the connection first." }, { status: 409 });
      const run = await runConnection(db, conn, "staff", fetch, process.env, now);
      await appendAuditPg(db, { id: randomUUID(), occurredAt: now, actorType: "user", actorId: staff.id, aggregateType: "feed_connection", aggregateId: id,
        eventType: "feed.run_started", correlationId: randomUUID(), payload: { runId: run.id, status: run.status } });
      return NextResponse.json({ run });
    }
    case "pause":
    case "resume":
      await setConnectionEnabled(db, staff.id, id, body.action === "resume", now);
      return NextResponse.json({ ok: true });
    case "rotate_token": {
      const token = await rotatePushToken(db, staff.id, id, now);
      return token ? NextResponse.json({ pushToken: token }, { headers: NO_STORE }) : NextResponse.json({ error: "Only CRM feeds have a push token." }, { status: 400 });
    }
    // {action:"enable_outbound", url} turns on status sync to the CRM's webhook (also used to change the address or get a new secret, shown once).
    case "enable_outbound": {
      const r = await enableOutbound(db, staff.id, id, body.url, now);
      return r.ok ? NextResponse.json({ secret: r.secret }, { headers: NO_STORE }) : NextResponse.json({ error: r.message }, { status: 400 });
    }
    case "disable_outbound":
      await disableOutbound(db, staff.id, id, now);
      return NextResponse.json({ ok: true });
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
