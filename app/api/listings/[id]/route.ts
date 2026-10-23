import { NextResponse } from "next/server";
import { getListing, parseDraftPatch, updateDraft } from "../../../../src/domain/listing-service";
import { getActor, getDeps } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const r = await getListing(getDeps(), getActor(req), id);
  return r.ok ? NextResponse.json({ listing: r.value }) : failure(r);
}

/** Edits a draft. Published listings cannot be edited here. */
export async function PATCH(req: Request, { params }: Ctx) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const parsed = parseDraftPatch(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  const { id } = await params;
  const r = await updateDraft(getDeps(), actor, id, parsed.value);
  return r.ok ? NextResponse.json({ listing: r.value }) : failure(r);
}
