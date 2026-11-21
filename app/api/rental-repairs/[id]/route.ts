import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { createRentalSender, ownerRepairAction, tenantRepairAction } from "../../../../src/server/elena-rentals-db";
import { failure, unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const TENANT = new Set(["fixed", "not_fixed", "consent_visit", "cancel"]);

/**
 * One person acting on a repair. The tenant: { action: "fixed" | "not_fixed" | "consent_visit" | "cancel" }. The listing's owner:
 * { action: "approve" | "choose_other" | "arrange_myself" | "send_emergency" | "close" | "reopen" }. Each checks the caller's own side; anyone else gets 404.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const b = (await req.json().catch(() => null)) as { action?: unknown } | null;
  const db = getDb(), sender = createRentalSender(db), now = new Date().toISOString();
  if (typeof b?.action === "string" && TENANT.has(b.action)) {
    // "cancel" and "fixed" can also come from the owner via "close"; the tenant actions only work for the tenant.
    const r = await tenantRepairAction(db, sender, process.env, actor.userId, id, b.action, now);
    return r.ok ? NextResponse.json({ ok: true }) : failure(r);
  }
  const r = await ownerRepairAction(db, sender, process.env, actor.userId, id, b?.action, now);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const POST = withApi(handlePost);
