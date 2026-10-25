import { NextResponse } from "next/server";
import { parsePriceInput } from "../../../../src/domain/billing-service";
import { staffCan } from "../../../../src/domain/staff-access";
import { getBilling, getStaff } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { withApi } from "../../../../src/server/api/with-api";

const NEED_STAFF = () => NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
const NOT_ALLOWED = () => NextResponse.json({ error: "Not allowed." }, { status: 403 });

/** Current prices and the full price history. Only pricing.manage (super admin). */
async function handleGet(req: Request) {
  const staff = await getStaff(req);
  if (!staff) return NEED_STAFF();
  if (!staffCan(staff, "pricing.manage")) return NOT_ALLOWED();
  const store = getBilling();
  return NextResponse.json({ current: await store.currentPrices(), history: await store.priceHistory() });
}

/** Sets a plan price (excluding GST) as a new row with a required reason. Rows are never edited, so history is kept. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const staff = await getStaff(req);
  if (!staff) return NEED_STAFF();
  if (!staffCan(staff, "pricing.manage")) return NOT_ALLOWED();
  const parsed = parsePriceInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  await getBilling().addPrice({ ...parsed.value, setBy: staff.id });
  return NextResponse.json({ ok: true }, { status: 201 });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
