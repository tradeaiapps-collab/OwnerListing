import { NextResponse } from "next/server";
import { listTemplates } from "../../../src/domain/signing-service";
import { getActor } from "../../../src/server/context";
import { failure, unauthenticated } from "../../../src/server/http";
import { getSigningRepo } from "../../../src/server/signing-db";
import { withApi } from "../../../src/server/api/with-api";

/** Published document templates an owner or agent can generate from (key, title, category, the fields to fill in). */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await listTemplates(getSigningRepo(), actor);
  return r.ok ? NextResponse.json({ templates: r.value }) : failure(r);
}

export const GET = withApi(handleGet);
