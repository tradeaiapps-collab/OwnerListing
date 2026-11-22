import { NextResponse } from "next/server";
import { elenaGate, invFailure, smallJson } from "../../../../../../../src/server/elena-projects-route";
import { ok } from "../../../../../../../src/server/investment-route";
import { withApi } from "../../../../../../../src/server/api/with-api";
import { editDraft } from "../../../../../../../src/domain/elena-projects-service";

/** Owner edits a draft update: { title, body }. A published update cannot be changed. */
async function handlePatch(req: Request, { params }: { params: Promise<{ id: string; uid: string }> }) {
  const { id, uid } = await params;
  const g = await elenaGate(req, [id, uid]);
  if (g instanceof NextResponse) return g;
  const r = await editDraft(g.deps, g.store, g.actor, id, uid, await smallJson(req));
  return r.ok ? ok({ update: r.value }) : invFailure(r);
}
export const PATCH = withApi(handlePatch);
