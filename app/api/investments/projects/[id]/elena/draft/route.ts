import { NextResponse } from "next/server";
import { elenaGate, invFailure, smallJson } from "../../../../../../../src/server/elena-projects-route";
import { ok } from "../../../../../../../src/server/investment-route";
import { withApi } from "../../../../../../../src/server/api/with-api";
import { draftForOwner } from "../../../../../../../src/domain/elena-projects-service";

/** Owner asks Elena to draft an update from new documents. The draft stays private to the owner until they approve it. */
async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await elenaGate(req, [id]);
  if (g instanceof NextResponse) return g;
  const r = await draftForOwner(g.deps, g.store, g.docs, g.ports, g.actor, id);
  return r.ok ? ok({ update: r.value }, 201) : invFailure(r);
}
export const POST = withApi(handlePost);
