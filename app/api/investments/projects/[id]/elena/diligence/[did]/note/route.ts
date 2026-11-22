import { NextResponse } from "next/server";
import { elenaGate, invFailure, smallJson } from "../../../../../../../../../src/server/elena-projects-route";
import { createPgDiligenceStore } from "../../../../../../../../../src/server/elena-diligence-db";
import { getDb } from "../../../../../../../../../src/server/context";
import { ok } from "../../../../../../../../../src/server/investment-route";
import { withApi } from "../../../../../../../../../src/server/api/with-api";
import { saveDiligenceNote } from "../../../../../../../../../src/domain/elena-diligence-service";

/** The owner's own note next to Elena's findings (draft only). */
async function handlePut(req: Request, { params }: { params: Promise<{ id: string; did: string }> }) {
  const { id, did } = await params;
  const g = await elenaGate(req, [id, did]);
  if (g instanceof NextResponse) return g;
  const body = (await smallJson(req)) as { note?: unknown } | null;
  const r = await saveDiligenceNote(g.deps, createPgDiligenceStore(getDb()), g.actor, id, did, body?.note);
  return r.ok ? ok(r.value) : invFailure(r);
}
export const PUT = withApi(handlePut);
