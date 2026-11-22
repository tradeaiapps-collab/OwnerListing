import { NextResponse } from "next/server";
import { elenaGate, invFailure, ocrText } from "../../../../../../../src/server/elena-projects-route";
import { createPgDiligenceStore } from "../../../../../../../src/server/elena-diligence-db";
import { getDb } from "../../../../../../../src/server/context";
import { ok } from "../../../../../../../src/server/investment-route";
import { withApi } from "../../../../../../../src/server/api/with-api";
import { generateDiligence, getDiligence } from "../../../../../../../src/domain/elena-diligence-service";

/** The owner's draft and the latest published summary; investors get the published one only. */
async function handleGet(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await elenaGate(req, [id]);
  if (g instanceof NextResponse) return g;
  const r = await getDiligence(g.deps, createPgDiligenceStore(getDb()), g.docs, g.actor, id);
  return r.ok ? ok(r.value) : invFailure(r);
}
/** Owner asks Elena to read the documents and write (or rewrite) the private draft. */
async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await elenaGate(req, [id]);
  if (g instanceof NextResponse) return g;
  const r = await generateDiligence(g.deps, createPgDiligenceStore(getDb()), g.docs, { ...g.ports, text: ocrText }, g.actor, id);
  return r.ok ? ok({ summary: r.value }, 201) : invFailure(r);
}
export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
