import { NextResponse } from "next/server";
import { isUuid } from "../../../../../src/domain/offer-decision";
import { declineOfferLinkFromThread, issueOfferLinkFromThread, offerLinkState, requestOfferLink } from "../../../../../src/domain/offer-link-request";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { getOfferLinkDeps } from "../../../../../src/server/enquiry-db";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { requireCurrentTerms } from "../../../../../src/server/terms-guard";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

const notFound = { ok: false, code: "not_found", message: "Enquiry not found." } as const;
const NO_STORE = { "Cache-Control": "no-store" };

/** Request state for either party. The raw link token is included for the buyer only, and only while it is still usable. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return failure(notFound);
  const r = await offerLinkState(getOfferLinkDeps(), actor, id);
  return r.ok ? NextResponse.json(r.value, { headers: NO_STORE }) : failure(r);
}

/**
 * Body: { "action": "request" | "issue" | "decline" }. The buyer requests; only the listing owner issues or declines.
 * Nothing here accepts an offer. The offer itself is still submitted on /offers/new with the single-use link.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return failure(notFound);
  const body: unknown = await req.json().catch(() => null);
  const action = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["action"] : undefined;
  const deps = getOfferLinkDeps();
  // Requesting or issuing a link needs the current terms (declining does not).
  if (action === "request" || action === "issue") {
    const noTerms = await requireCurrentTerms(deps.termsCurrentFor, actor.userId);
    if (noTerms) return failure(noTerms);
  }
  if (action === "request") {
    const r = await requestOfferLink(deps, actor, id);
    return r.ok ? NextResponse.json({ request: r.value }, { status: 201 }) : failure(r);
  }
  if (action === "issue") {
    const r = await issueOfferLinkFromThread(deps, actor, id);
    return r.ok ? NextResponse.json(r.value, { status: 201, headers: NO_STORE }) : failure(r);
  }
  if (action === "decline") {
    const r = await declineOfferLinkFromThread(deps, actor, id);
    return r.ok ? NextResponse.json({ declined: true }) : failure(r);
  }
  return failure({ ok: false, code: "invalid", message: "Unknown action." });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
