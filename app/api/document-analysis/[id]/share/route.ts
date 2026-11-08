import { NextResponse } from "next/server";
import { shareAnalysis } from "../../../../../src/domain/doc-analysis-service";
import { csrfGuard } from "../../../../../src/server/csrf";
import { getActor } from "../../../../../src/server/context";
import { getAnalystDeps } from "../../../../../src/server/doc-analysis";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Body: { userIds: [...] }. Owner only. People who cannot already view the document are skipped, never granted access. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const body: unknown = await req.json().catch(() => null);
  const ids = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["userIds"] : undefined;
  if (!UUID.test(id) || !Array.isArray(ids) || !ids.every((x): x is string => typeof x === "string" && UUID.test(x))) return failure({ ok: false, code: "invalid", message: "Send userIds as a list of user ids." });
  const r = await shareAnalysis(getAnalystDeps(), actor, id, ids);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const POST = withApi(handlePost);
