import { NextResponse } from "next/server";
import { elenaGate, invFailure, smallJson } from "../../../../../../../../src/server/elena-projects-route";
import { ok } from "../../../../../../../../src/server/investment-route";
import { withApi } from "../../../../../../../../src/server/api/with-api";
import { approveUpdate } from "../../../../../../../../src/domain/elena-projects-service";

/** Owner approves a draft. It becomes visible to investors and followers are notified (a notice with a link, not the text). */
async function handlePost(req: Request, { params }: { params: Promise<{ id: string; uid: string }> }) {
  const { id, uid } = await params;
  const g = await elenaGate(req, [id, uid]);
  if (g instanceof NextResponse) return g;
  const r = await approveUpdate(g.deps, g.store, g.actor, id, uid);
  return r.ok ? ok(r.value) : invFailure(r);
}
export const POST = withApi(handlePost);
