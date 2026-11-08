import { NextResponse } from "next/server";
import { localDateInZone } from "../../../../src/domain/timezone";
import { getActor } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../src/server/http";
import { actOnBookings, isId, repo } from "../../../../src/server/open-inspection-service";
import { withApi } from "../../../../src/server/api/with-api";

const DAY = 86_400_000;
const date = (v: string | null, fallback: number) => { const t = v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN; return Number.isNaN(t) ? fallback : t; };

/** Calendar data for the signed-in owner or appointed agent: bookings across the listings they manage in `?from=&to=` (YYYY-MM-DD, at most 92 days, default last 7 and next 60 days), their listings, and how many inspections are today. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "owner" && actor.userType !== "agent") return NextResponse.json({ error: "Only owners and agents manage inspections." }, { status: 403 });
  const now = Date.now(), q = new URL(req.url).searchParams;
  const from = date(q.get("from"), now - 7 * DAY), to = Math.min(date(q.get("to"), now + 60 * DAY), from + 92 * DAY);
  const listingId = q.get("listingId");
  const [bookings, listings] = await Promise.all([repo().managerBookings(actor.userId, new Date(from).toISOString(), new Date(to).toISOString(), isId(listingId) ? listingId : undefined), repo().myListings(actor.userId)]);
  const nowIso = new Date(now).toISOString();
  const today = bookings.filter(b => b.status === "booked" && localDateInZone(b.startsAt, b.timezone) === localDateInZone(nowIso, b.timezone)).length;
  return NextResponse.json({ bookings, listings, today }, { headers: { "cache-control": "no-store" } });
}

/** Body: { ids: [booking ids], action: "cancel" | "complete" | "no_show" | "remind" }. Only bookings on listings the user manages, and only where the action fits, are changed. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await actOnBookings(repo(), actor, await req.json().catch(() => null), new Date().toISOString());
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
