import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { staffCan } from "../../../../../src/domain/staff-access";
import { supportViewDocument } from "../../../../../src/domain/signing-service";
import { getDb, getStaff } from "../../../../../src/server/context";
import { appendAuditPg } from "../../../../../src/server/db";
import { failure } from "../../../../../src/server/http";
import { getSigningRepo } from "../../../../../src/server/signing-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const NO_STORE = { "cache-control": "private, no-store" };

/**
 * Support staff read a sent signing document and its audit trail for a dispute. Needs signing.support_view and ?reason=dispute-support.
 * The read is written to the platform audit log first; if that fails nothing is returned. Drafts and unknown ids are 404.
 */
async function handleGet(req: Request, { params }: Ctx) {
  const staff = await getStaff(req);
  if (!staff) return NextResponse.json({ error: "Sign in as staff." }, { status: 401, headers: NO_STORE });
  if (!staffCan(staff, "signing.support_view")) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE });
  if (new URL(req.url).searchParams.get("reason") !== "dispute-support") return NextResponse.json({ error: "State the reason: reason=dispute-support." }, { status: 400, headers: NO_STORE });
  const { id } = await params;
  const r = await supportViewDocument(getSigningRepo(), id);
  if (!r.ok) return failure(r);
  await appendAuditPg(getDb(), {
    id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: staff.id, aggregateType: "signing_document", aggregateId: r.value.document.id,
    eventType: "staff.signing_document_viewed", correlationId: randomUUID(), payload: { role: staff.role, viewReason: "dispute-support", status: r.value.document.status }
  });
  return NextResponse.json(r.value, { headers: NO_STORE });
}

export const GET = withApi(handleGet);
