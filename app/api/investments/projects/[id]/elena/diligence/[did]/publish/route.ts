import { NextResponse } from "next/server";
import { elenaGate, invFailure } from "../../../../../../../../../src/server/elena-projects-route";
import { createPgDiligenceStore } from "../../../../../../../../../src/server/elena-diligence-db";
import { getDb } from "../../../../../../../../../src/server/context";
import { ok } from "../../../../../../../../../src/server/investment-route";
import { withApi } from "../../../../../../../../../src/server/api/with-api";
import { approveDiligence } from "../../../../../../../../../src/domain/elena-diligence-service";

/** The owner approves their draft; investors can read it from then on. */
async function handlePost(req: Request, { params }: { params: Promise<{ id: string; did: string }> }) {
  const { id, did } = await params;
  const g = await elenaGate(req, [id, did]);
  if (g instanceof NextResponse) return g;
  const r = await approveDiligence(g.deps, createPgDiligenceStore(getDb()), g.actor, id, did);
  return r.ok ? ok(r.value) : invFailure(r);
}
export const POST = withApi(handlePost);
