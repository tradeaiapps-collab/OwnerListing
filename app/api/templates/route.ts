import { NextResponse } from "next/server";
import { getActor } from "../../../src/server/context";
import { failure, unauthenticated } from "../../../src/server/http";
import { csrfGuard } from "../../../src/server/csrf";
import { withApi } from "../../../src/server/api/with-api";
import { getTemplateDeps } from "../../../src/server/listing-template-db";
import { createTemplate, listTemplates } from "../../../src/domain/listing-template";

/** The signed-in owner's or agent's templates plus their team's: ?category=house&furnishing=furnished to filter. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const q = new URL(req.url).searchParams;
  const r = await listTemplates(getTemplateDeps(), actor, { category: q.get("category") ?? undefined, furnishing: q.get("furnishing") ?? undefined });
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : failure(r);
}

/** Create a template: { name, category, furnishing?, note?, content?, teamId? } or from a listing: { fromListingId, name, category }. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await createTemplate(getTemplateDeps(), actor, await req.json().catch(() => null));
  return r.ok ? NextResponse.json({ template: r.value }, { status: 201 }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
