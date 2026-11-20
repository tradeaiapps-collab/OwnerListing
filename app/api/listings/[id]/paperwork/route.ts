import { NextResponse } from "next/server";
import { windowStart, withinLimit } from "../../../../../src/domain/rate-limit";
import { getActor, getDb, getDeps } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { countHitPg } from "../../../../../src/server/offer-flow-db";
import { requireListingHandler } from "../../../../../src/server/owner-listing";
import { loadPaperwork, paperworkView, saveChaseSetting } from "../../../../../src/server/sale-paperwork-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = { ok: false, code: "not_found", message: "Not found." } as const;
const RATE = { windowMs: 60 * 60 * 1000, perUser: 120 } as const;

/**
 * The sale paperwork checklist for this listing, for its owner or appointed agent: what is done, what blocks the sale or settlement, and what
 * Elena has sent. Items come from rules the platform already has (compliance disclosures, the publish gate, the settlement tracker). No buyer
 * identity, no offer terms and no files are returned. Workflow help, not legal advice.
 */
async function handleGet(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID.test(id)) return failure(NOT_FOUND);
  const handler = await requireListingHandler(req, id, "offers.view");
  if (handler instanceof NextResponse) return handler;
  const db = getDb();
  const hits = await countHitPg(db, `paperwork:${handler.actor.userId}`, windowStart(getDeps().now(), RATE.windowMs));
  if (!withinLimit(hits, RATE.perUser)) return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  const data = await loadPaperwork(db, id);
  if (!data) return failure(NOT_FOUND);
  return NextResponse.json({ ...(await paperworkView(db, id, data)), canChange: !handler.asAgent }, { headers: { "cache-control": "private, no-store" } });
}

/** Body: { chase: boolean }. Owner only. Turns Elena's paperwork reminders on or off for this listing. */
async function handlePut(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID.test(id)) return failure(NOT_FOUND);
  const body = (await req.json().catch(() => null)) as { chase?: unknown } | null;
  if (typeof body?.chase !== "boolean") return failure({ ok: false, code: "invalid", message: "Send chase as true or false." });
  if (!(await saveChaseSetting(getDb(), actor.userId, id, body.chase))) return failure(NOT_FOUND);
  return NextResponse.json({ chase: body.chase });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
