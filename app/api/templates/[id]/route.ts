import { NextResponse } from "next/server";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";
import { csrfGuard } from "../../../../src/server/csrf";
import { withApi } from "../../../../src/server/api/with-api";
import { getTemplateDeps } from "../../../../src/server/listing-template-db";
import { deleteTemplate, getTemplate, updateTemplate } from "../../../../src/domain/listing-template";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: "Template not found." }, { status: 404 });

async function handleGet(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return notFound();
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await getTemplate(getTemplateDeps(), actor, id);
  return r.ok ? NextResponse.json({ template: r.value }, { headers: { "cache-control": "no-store" } }) : failure(r);
}

/** Edit, share ({ teamId }) or unshare ({ teamId: null }). */
async function handlePatch(req: Request, ctx: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return notFound();
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await updateTemplate(getTemplateDeps(), actor, id, await req.json().catch(() => null));
  return r.ok ? NextResponse.json({ template: r.value }) : failure(r);
}

async function handleDelete(req: Request, ctx: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return notFound();
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await deleteTemplate(getTemplateDeps(), actor, id);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const GET = withApi(handleGet);
export const PATCH = withApi(handlePatch);
export const DELETE = withApi(handleDelete);
