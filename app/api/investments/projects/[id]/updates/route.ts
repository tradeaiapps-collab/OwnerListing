import { NextResponse } from "next/server";
import { elenaGate, invFailure, smallJson } from "../../../../../../src/server/elena-projects-route";
import { ok } from "../../../../../../src/server/investment-route";
import { withApi } from "../../../../../../src/server/api/with-api";
import { listUpdates } from "../../../../../../src/domain/elena-projects-service";

/** Published updates (the owner also sees drafts), and whether this investor follows the project. */
async function handleGet(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await elenaGate(req, [id]);
  if (g instanceof NextResponse) return g;
  const r = await listUpdates(g.deps, g.store, g.actor, id);
  return r.ok ? ok(r.value) : invFailure(r);
}
export const GET = withApi(handleGet);
