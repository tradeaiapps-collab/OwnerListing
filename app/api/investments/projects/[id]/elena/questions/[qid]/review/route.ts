import { NextResponse } from "next/server";
import { elenaGate, invFailure, smallJson } from "../../../../../../../../../src/server/elena-projects-route";
import { ok } from "../../../../../../../../../src/server/investment-route";
import { withApi } from "../../../../../../../../../src/server/api/with-api";
import { decideAnswer } from "../../../../../../../../../src/domain/elena-projects-service";

/** Owner decides on Elena's drafted answer: { decision: "approve" | "edit" | "discard", body? }. body is the owner's own wording for "edit". */
async function handlePost(req: Request, { params }: { params: Promise<{ id: string; qid: string }> }) {
  const { id, qid } = await params;
  const g = await elenaGate(req, [id, qid]);
  if (g instanceof NextResponse) return g;
  const b = await smallJson(req);
  const o = typeof b === "object" && b !== null ? (b as Record<string, unknown>) : {};
  const r = await decideAnswer(g.deps, g.store, g.actor, id, qid, o["decision"], o["body"]);
  return r.ok ? ok(r.value) : invFailure(r);
}
export const POST = withApi(handlePost);
