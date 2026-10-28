import { NextResponse } from "next/server";
import { discardDraft, sendDraft } from "../../../../../src/domain/enquiry-service";
import { isUuid } from "../../../../../src/domain/offer-decision";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { getEnquiryDeps } from "../../../../../src/server/enquiry-db";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Owner only. Body: { "action": "discard" | "send" }. "send" posts the draft as the owner's own message. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return failure({ ok: false, code: "not_found", message: "Draft not found." });
  const body: unknown = await req.json().catch(() => null);
  const action = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["action"] : undefined;
  if (action !== "discard" && action !== "send") return failure({ ok: false, code: "invalid", message: "Action must be discard or send." });
  const deps = getEnquiryDeps();
  const r = action === "send" ? await sendDraft(deps, actor, id) : await discardDraft(deps, actor, id);
  return r.ok ? NextResponse.json({ ok: true }) : failure(r);
}

export const POST = withApi(handlePost);
