import { NextResponse } from "next/server";
import { isUuid } from "../../../../../src/domain/offer-decision";
import { activityFor, archiveWorkflow, updateWorkflow } from "../../../../../src/server/automation-db";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const notFound = () => failure({ ok: false, code: "not_found", message: "Workflow not found." });

/** Activity for one workflow: run counts and the newest log lines (what was sent, skipped or failed, and when). */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return notFound();
  const a = await activityFor(getDb(), actor.userId, id);
  return a ? NextResponse.json(a, { headers: { "cache-control": "no-store" } }) : notFound();
}

/** Change a workflow: any of { name, definition, listingId, active }. Runs already started keep the steps they started with. */
async function handlePatch(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return notFound();
  const body = await req.json().catch(() => null);
  const r = await updateWorkflow(getDb(), actor.userId, id, typeof body === "object" && body !== null ? body : {});
  if (r.ok) return NextResponse.json(r.value);
  return r.message === "Workflow not found." ? notFound() : failure({ ok: false, code: "invalid", message: r.message });
}

/** Archives the workflow and ends its unfinished runs. Its history stays. */
async function handleDelete(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return notFound();
  return (await archiveWorkflow(getDb(), actor.userId, id)) ? NextResponse.json({ ok: true }) : notFound();
}

export const GET = withApi(handleGet);
export const PATCH = withApi(handlePatch);
export const DELETE = withApi(handleDelete);
