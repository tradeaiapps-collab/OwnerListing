import { NextResponse } from "next/server";
import { elenaGate, invFailure, smallJson } from "../../../../../../../src/server/elena-projects-route";
import { ok } from "../../../../../../../src/server/investment-route";
import { withApi } from "../../../../../../../src/server/api/with-api";
import { askElena } from "../../../../../../../src/domain/elena-projects-service";

/** An investor asks Elena a question about the project: { question }. Answers only by quoting published documents; otherwise passes it to the owner. */
async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await elenaGate(req, [id]);
  if (g instanceof NextResponse) return g;
  const body = await smallJson(req);
  const r = await askElena(g.deps, g.store, g.docs, g.ports, g.actor, id, typeof body === "object" && body !== null ? (body as Record<string, unknown>)["question"] : undefined);
  return r.ok ? ok(r.value, 201) : invFailure(r);
}
export const POST = withApi(handlePost);
