import { NextResponse } from "next/server";
import { isPortal, parseListingPortalInput } from "../../../../../src/domain/syndication";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { canManageListing, listBookings, listingSyndication, saveListingSetting, syndicateListing, syndicationDeps } from "../../../../../src/server/syndication-db";
import { UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const notFound = () => failure({ ok: false, code: "not_found", message: "Listing not found." });

/** Portals this listing can be shared on, its choices, sync state and the bookings received. Owner or appointed agent (full scope) only; others get 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID_RE.test(id) || !(await canManageListing(getDb(), id, actor.userId))) return notFound();
  return NextResponse.json({ portals: await listingSyndication(getDb(), id), bookings: await listBookings(getDb(), id) }, { headers: { "cache-control": "no-store" } });
}

/** Body: { portal, enabled, custom?: { houseRules, cancellationPolicy, minNights, maxGuests }, manualUrl? }. Takes effect at once (best effort) and on the next scheduled run. */
async function handlePut(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID_RE.test(id) || !(await canManageListing(getDb(), id, actor.userId))) return notFound();
  const body: unknown = await req.json().catch(() => null);
  const portal = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["portal"] : undefined;
  if (!isPortal(portal)) return NextResponse.json({ error: "Choose a portal." }, { status: 400 });
  const input = parseListingPortalInput(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  const deps = syndicationDeps();
  const r = await saveListingSetting(getDb(), actor.userId, id, portal, input.value, deps.now());
  if (r === "not_available") return NextResponse.json({ error: "That portal is not switched on yet.", code: "not_available" }, { status: 409 });
  if (r === "not_allowed_category") return NextResponse.json({ error: "That portal does not take this type of listing.", code: "category" }, { status: 409 });
  await syndicateListing(getDb(), deps, id);
  return NextResponse.json({ portals: await listingSyndication(getDb(), id) });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
