import { NextResponse } from "next/server";
import { elenaGate, invFailure, smallJson } from "../../../../../../../src/server/elena-projects-route";
import { ok } from "../../../../../../../src/server/investment-route";
import { withApi } from "../../../../../../../src/server/api/with-api";
import { reviewForOwner } from "../../../../../../../src/domain/elena-projects-service";

/** Owner only: documents Elena thinks are missing or stale, and how many new documents an update could cover. */
async function handleGet(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await elenaGate(req, [id]);
  if (g instanceof NextResponse) return g;
  const r = await reviewForOwner(g.deps, g.store, g.docs, g.actor, id);
  return r.ok ? ok(r.value) : invFailure(r);
}
export const GET = withApi(handleGet);
