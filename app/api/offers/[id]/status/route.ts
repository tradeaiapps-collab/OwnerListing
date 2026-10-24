import { NextResponse } from "next/server";
import { changeStatus, type OfferStatus } from "../../../../../src/domain/offer-service";
import { fail } from "../../../../../src/domain/listing-service";
import { getActor, getOfferDeps } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";

type Ctx = { params: Promise<{ id: string }> };
const SETTABLE: readonly OfferStatus[] = ["under_review", "rejected", "accepted", "withdrawn"];

/** Owner: under_review, rejected or accepted. Buyer: withdrawn. */
export async function POST(req: Request, { params }: Ctx) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const body: unknown = await req.json().catch(() => null);
  const status = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["status"] : undefined;
  const to = SETTABLE.find(s => s === status);
  if (!to) return failure(fail("invalid", "Invalid status."));
  const { id } = await params;
  const r = await changeStatus(getOfferDeps(), actor, id, to);
  return r.ok ? NextResponse.json({ offer: r.value }) : failure(r);
}
