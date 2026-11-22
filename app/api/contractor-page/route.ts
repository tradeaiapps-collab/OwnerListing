import { NextResponse } from "next/server";
import { parsePageInput } from "../../../src/domain/contractor-market";
import { withApi } from "../../../src/server/api/with-api";
import { loadOwnPage, savePage } from "../../../src/server/contractor-market-db";
import { getActor, getDb } from "../../../src/server/context";
import { csrfGuard } from "../../../src/server/csrf";
import { failure, unauthenticated } from "../../../src/server/http";

/** The signed-in contractor's own public page, priced services, gallery links and job figures. The id always comes from the session. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json(await loadOwnPage(getDb(), actor.userId));
}

/** Saves the whole page. Owners are paid by the contractor's own displayed price outside the platform; nothing here takes payment. */
async function handlePut(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "vendor" && actor.userType !== "agent") return failure({ ok: false, code: "forbidden", message: "Only contractor accounts have a contractor page." });
  const parsed = parsePageInput(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  const no = await savePage(getDb(), actor.userId, parsed.value);
  return NextResponse.json({ contractorNo: no });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
