import { NextResponse } from "next/server";
import { elenaGate, invFailure, smallJson } from "../../../../../../../../../src/server/elena-projects-route";
import { ok } from "../../../../../../../../../src/server/investment-route";
import { withApi } from "../../../../../../../../../src/server/api/with-api";
import { replyToQuestion } from "../../../../../../../../../src/domain/elena-projects-service";

/** Owner replies to a question: { body }. */
async function handlePost(req: Request, { params }: { params: Promise<{ id: string; qid: string }> }) {
  const { id, qid } = await params;
  const g = await elenaGate(req, [id, qid]);
  if (g instanceof NextResponse) return g;
  const body = await smallJson(req);
  const r = await replyToQuestion(g.deps, g.store, g.actor, id, qid, typeof body === "object" && body !== null ? (body as Record<string, unknown>)["body"] : undefined);
  return r.ok ? ok(r.value, 201) : invFailure(r);
}
export const POST = withApi(handlePost);
