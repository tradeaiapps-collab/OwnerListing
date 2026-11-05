import { NextResponse } from "next/server";
import { isPortal } from "../../../../../../src/domain/syndication";
import { getActor, getDb } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { canManageListing, listCalendarImports, removeCalendarImport, saveCalendarImport, syncCalendarImport, syndicationDeps } from "../../../../../../src/server/syndication-db";
import { UUID_RE } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

async function guard(req: Request, params: Ctx["params"]) {
  const blocked = csrfGuard(req);
  if (blocked) return { res: blocked } as const;
  const actor = await getActor(req);
  if (!actor) return { res: unauthenticated() } as const;
  const { id } = await params;
  if (!UUID_RE.test(id) || !(await canManageListing(getDb(), id, actor.userId))) return { res: failure({ ok: false, code: "not_found", message: "Listing not found." }) } as const;
  const body: unknown = await req.json().catch(() => null);
  const rec = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (!isPortal(rec["portal"])) return { res: NextResponse.json({ error: "Choose a portal." }, { status: 400 }) } as const;
  return { id, actor, portal: rec["portal"], rec } as const;
}

/** Body: { portal, url }. Saves the portal's calendar (iCal) link, sealed, and imports it now. Owner or appointed agent (full scope) only. */
async function handlePut(req: Request, { params }: Ctx) {
  const g = await guard(req, params);
  if ("res" in g) return g.res;
  const r = await saveCalendarImport(getDb(), syndicationDeps(), g.actor.userId, g.id, g.portal, g.rec["url"]);
  if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.code === "key_not_configured" ? 503 : 400 });
  return NextResponse.json({ outcome: r.outcome, calendars: await listCalendarImports(getDb(), g.id) });
}

/** Body: { portal }. Imports that portal's calendar now. */
async function handlePost(req: Request, { params }: Ctx) {
  const g = await guard(req, params);
  if ("res" in g) return g.res;
  const outcome = await syncCalendarImport(getDb(), syndicationDeps(), g.id, g.portal);
  if (outcome === "unconfigured") return NextResponse.json({ error: "Save the calendar link first." }, { status: 409 });
  return NextResponse.json({ outcome, calendars: await listCalendarImports(getDb(), g.id) });
}

/** Body: { portal }. Stops importing and frees the dates that portal was blocking. */
async function handleDelete(req: Request, { params }: Ctx) {
  const g = await guard(req, params);
  if ("res" in g) return g.res;
  await removeCalendarImport(getDb(), g.actor.userId, g.id, g.portal, syndicationDeps().now());
  return NextResponse.json({ calendars: await listCalendarImports(getDb(), g.id) });
}

export const PUT = withApi(handlePut);
export const POST = withApi(handlePost);
export const DELETE = withApi(handleDelete);
