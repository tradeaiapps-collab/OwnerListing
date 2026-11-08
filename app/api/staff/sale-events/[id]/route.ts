import { NextResponse } from "next/server";
import { reasonOk } from "../../../../../src/domain/staff-admin";
import { getDb, getDeps } from "../../../../../src/server/context";
import { voidSaleEventPg } from "../../../../../src/server/sale-events-db";
import { fail, readJsonObject, staffAudit, staffGate, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** Void a sold or rented event (wrong figure, duplicate, or a sale that fell through). Body: { reason } of 10 to 1000 characters. The row is kept. */
async function handlePost(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const staff = await staffGate(req, "sale_event.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return fail(404, "Event not found.");
  const b = await readJsonObject(req);
  if (!reasonOk(b?.["reason"]) || (b!["reason"] as string).trim().length > 1000) return fail(400, "Give a reason of 10 to 1000 characters.");
  const reason = (b!["reason"] as string).trim();
  const r = await voidSaleEventPg(getDb(), id, staff.id, reason, getDeps().now());
  if (r.outcome === "not_found") return fail(404, "Event not found.");
  if (r.outcome === "already_voided") return fail(409, "This event is already voided.");
  await staffAudit(staff, "property_event", id, "staff.sale_event_voided", { reason, propertyId: r.propertyId });
  return NextResponse.json({ ok: true });
}

export const POST = withApi(handlePost);
