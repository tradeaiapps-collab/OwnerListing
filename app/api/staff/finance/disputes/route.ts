import { NextResponse } from "next/server";
import { staffCan } from "../../../../../src/domain/staff-access";
import { getDb, getStaff } from "../../../../../src/server/context";
import { listDisputes } from "../../../../../src/server/finance-db";
import { withApi } from "../../../../../src/server/api/with-api";

/** Payment issues raised by customers, ?status=open|closed (default open). billing.manage (the text is customer-written). */
async function handleGet(req: Request) {
  const staff = await getStaff(req);
  if (!staff) return NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
  if (!staffCan(staff, "billing.manage")) return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  const s = new URL(req.url).searchParams.get("status") ?? "open";
  if (s !== "open" && s !== "closed") return NextResponse.json({ error: "status must be open or closed." }, { status: 400 });
  return NextResponse.json({ disputes: await listDisputes(getDb(), s) }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
