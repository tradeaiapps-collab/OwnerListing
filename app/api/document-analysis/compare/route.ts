import { NextResponse } from "next/server";
import { compareDocuments } from "../../../../src/domain/doc-analysis-service";
import { csrfGuard } from "../../../../src/server/csrf";
import { getActor } from "../../../../src/server/context";
import { getAnalystDeps } from "../../../../src/server/doc-analysis";
import { failure, unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Body: { documentIds: [2 to 6 ids] }. Every document must be one the user may view. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const body: unknown = await req.json().catch(() => null);
  const ids = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["documentIds"] : undefined;
  if (!Array.isArray(ids) || !ids.every((x): x is string => typeof x === "string" && UUID.test(x))) return failure({ ok: false, code: "invalid", message: "Send documentIds as a list of document ids." });
  const r = await compareDocuments(getAnalystDeps(), actor, ids);
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "private, no-store" } }) : failure(r);
}

export const POST = withApi(handlePost);
