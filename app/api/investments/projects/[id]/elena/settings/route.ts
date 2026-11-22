import { NextResponse } from "next/server";
import { elenaGate, invFailure, smallJson } from "../../../../../../../src/server/elena-projects-route";
import { ok } from "../../../../../../../src/server/investment-route";
import { withApi } from "../../../../../../../src/server/api/with-api";
import { getAnswerMode, setAnswerMode } from "../../../../../../../src/domain/elena-projects-service";

/** Owner only. GET: how Elena answers investors ("approve_first" by default, or "instant"). PUT { answerMode }: change it. */
async function handleGet(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await elenaGate(req, [id]);
  if (g instanceof NextResponse) return g;
  const r = await getAnswerMode(g.deps, g.store, g.actor, id);
  return r.ok ? ok(r.value) : invFailure(r);
}
async function handlePut(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await elenaGate(req, [id]);
  if (g instanceof NextResponse) return g;
  const b = await smallJson(req);
  const r = await setAnswerMode(g.deps, g.store, g.actor, id, typeof b === "object" && b !== null ? (b as Record<string, unknown>)["answerMode"] : undefined);
  return r.ok ? ok(r.value) : invFailure(r);
}
export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
