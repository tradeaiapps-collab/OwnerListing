import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { createRentalSender, rentListing, submitApplication } from "../../../../../src/server/elena-rentals-db";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const NOT_FOUND = { ok: false, code: "not_found", message: "Not found." } as const;

/** What an applicant sees before applying: the address and weekly rent of a published rental. Nothing about the owner's criteria. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const l = await rentListing(getDb(), id);
  if (!l || l.status !== "published") return failure(NOT_FOUND);
  return NextResponse.json({ address: l.address, ...(l.weeklyRentCents ? { weeklyRentCents: l.weeklyRentCents } : {}) });
}

/** Body: { weeklyIncome?, rentalHistoryMonths?, referencesCount?, moveInDate?, note? }. Sending again updates the application. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const db = getDb();
  const r = await submitApplication(db, createRentalSender(db), actor.userId, id, await req.json().catch(() => null), new Date().toISOString());
  if (!r.ok) return failure(r);
  const { evaluation: _e, ...rest } = r.value;
  return NextResponse.json(rest, { status: 201 });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
