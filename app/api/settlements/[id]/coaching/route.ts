import { NextResponse } from "next/server";
import { isUuid } from "../../../../../src/domain/offer-decision";
import { isSuggestionType } from "../../../../../src/domain/settlement-coach";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { unauthenticated } from "../../../../../src/server/http";
import { coachingView, decideSuggestion } from "../../../../../src/server/settlement-coach-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

/** Elena's coaching for the signed-in person's side of one settlement. The side is worked out from the database. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return fail(404, "Settlement not found.");
  const r = await coachingView(getDb(), actor.userId, id);
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : fail(r.status, r.error);
}

/** POST { suggestion, decision: "use" | "dismiss" }: record what the person did with a suggestion. "use" returns its template to copy; nothing is sent. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return fail(404, "Settlement not found.");
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || !isSuggestionType(b["suggestion"]) || (b["decision"] !== "use" && b["decision"] !== "dismiss")) return fail(400, "Choose a suggestion and say whether to use or dismiss it.");
  const r = await decideSuggestion(getDb(), actor.userId, id, b["suggestion"], b["decision"] === "use");
  return r.ok ? NextResponse.json(r.value) : fail(r.status, r.error);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
