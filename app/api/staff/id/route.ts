import { NextResponse } from "next/server";
import { pendingQueue } from "../../../../src/domain/id-review-service";
import { getActor, getIdDeps } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";

export async function GET(req: Request) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const r = await pendingQueue(getIdDeps(), actor);
  if (!r.ok) return failure(r);
  // Image references and the identity details beyond what a reviewer needs are not sent.
  return NextResponse.json({
    items: r.value.map(({ submission: s, accountName }) => ({
      id: s.id, accountName, documentKind: s.documentKind, documentCountry: s.documentCountry, expiryDate: s.expiryDate,
      hasBack: Boolean(s.backImageRef), selfieCapturedInApp: s.selfieCapturedInApp, submittedAt: s.submittedAt,
      approvals: s.approvals.length, needsApprovals: s.documentCountry === "AU" ? 1 : 2,
      iHaveApproved: s.approvals.includes(actor.userId), isMine: s.userId === actor.userId
    }))
  });
}
