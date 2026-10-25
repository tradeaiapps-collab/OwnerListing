import { NextResponse } from "next/server";
import { csrfGuard } from "../../../../src/server/csrf";
import { abnCheckDeps, runAbnCheck } from "../../../../src/server/abn-check";
import { getActor, getDb, getStaff } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";

/**
 * Checks an ABN: checksum, then the ABR when ABN_LOOKUP_GUID is set. Body: { "abn": "51 824 753 556" }.
 * Signed-in people only (this is not an open lookup proxy) and rate limited. The reply carries the register's data only;
 * nothing the client sends is echoed back as an entity name.
 */
export async function POST(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  const staff = actor ? null : await getStaff(req);
  const personId = actor?.userId ?? staff?.id;
  if (!personId) return unauthenticated();
  const body: unknown = await req.json().catch(() => null);
  const abn = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["abn"] : undefined;
  const r = await runAbnCheck(abnCheckDeps(getDb()), personId, abn);
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : failure(r);
}
