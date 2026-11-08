import { NextResponse } from "next/server";
import { staffCan } from "../../../../../../../src/domain/staff-access";
import { getDb, getStaff } from "../../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../../src/server/csrf";
import { confirmBankTransfer } from "../../../../../../../src/server/finance-db";
import { withApi } from "../../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { amountCents, reference }. Staff confirm a bank transfer arrived. The amount must equal the invoice total exactly. billing.manage. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const staff = await getStaff(req);
  if (!staff) return NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
  if (!staffCan(staff, "billing.manage")) return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  const b = (await req.json().catch(() => null)) as { amountCents?: unknown; reference?: unknown } | null;
  if (typeof b?.amountCents !== "number" || !Number.isSafeInteger(b.amountCents) || b.amountCents < 0 || typeof b.reference !== "string") {
    return NextResponse.json({ error: "Send the amount in cents and the bank reference." }, { status: 400 });
  }
  const { id } = await params;
  const r = await confirmBankTransfer(getDb(), staff.id, id, b.amountCents, b.reference);
  return r.ok ? NextResponse.json({ ok: true, note: r.note }) : NextResponse.json({ error: r.error }, { status: r.status });
}

export const POST = withApi(handlePost);
