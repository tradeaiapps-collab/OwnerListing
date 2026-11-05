import { NextResponse } from "next/server";
import { staffCan } from "../../../../../../src/domain/staff-access";
import { getDb, getStaff } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { resolveDispute } from "../../../../../../src/server/finance-db";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { outcome: "resolved" | "rejected", resolution }. The written answer is shown to the customer. Moves no money. billing.manage. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const staff = await getStaff(req);
  if (!staff) return NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
  if (!staffCan(staff, "billing.manage")) return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  const b = (await req.json().catch(() => null)) as { outcome?: unknown; resolution?: unknown } | null;
  if ((b?.outcome !== "resolved" && b?.outcome !== "rejected") || typeof b.resolution !== "string") return NextResponse.json({ error: "Send an outcome and the written answer." }, { status: 400 });
  const { id } = await params;
  const r = await resolveDispute(getDb(), staff.id, id, b.outcome, b.resolution);
  return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status });
}

export const POST = withApi(handlePost);
