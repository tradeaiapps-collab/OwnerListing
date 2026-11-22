import { NextResponse } from "next/server";
import { parseDefinition, simulate, FIELDS, type Facts } from "../../../../../../src/domain/automation";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { getActor } from "../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { withApi } from "../../../../../../src/server/api/with-api";

/**
 * Dry run: { definition, facts? } walks the workflow on sample facts with every wait skipped, and returns what would be sent.
 * Nothing is saved or sent. The path id is "draft" for a workflow that is not saved yet.
 */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const body = (await req.json().catch(() => null)) as { definition?: unknown; facts?: Record<string, unknown> } | null;
  const def = parseDefinition(body?.definition);
  if (!def.ok) return failure({ ok: false, code: "invalid", message: def.message });
  const facts: Facts = {};
  for (const [k, v] of Object.entries(body?.facts ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(FIELDS, k)) continue;
    const key = k as keyof typeof FIELDS;
    if (FIELDS[key].type === "number" ? Number.isFinite(Number(v)) && v !== "" : typeof v === "string") facts[key] = FIELDS[key].type === "number" ? Number(v) : String(v).slice(0, 120);
  }
  return NextResponse.json(simulate(def.value, facts));
}

export const POST = withApi(handlePost);
