import { NextResponse } from "next/server";
import { elenaGate, invFailure, smallJson } from "../../../../../../../src/server/elena-projects-route";
import { ok } from "../../../../../../../src/server/investment-route";
import { withApi } from "../../../../../../../src/server/api/with-api";
import { listQuestions } from "../../../../../../../src/domain/elena-projects-service";

/** The owner: every question, Elena's answer and the owner's replies. An investor: only their own. */
async function handleGet(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await elenaGate(req, [id]);
  if (g instanceof NextResponse) return g;
  const r = await listQuestions(g.deps, g.store, g.actor, id);
  return r.ok ? ok(r.value) : invFailure(r);
}
export const GET = withApi(handleGet);
