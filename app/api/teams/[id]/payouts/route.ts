import { NextResponse } from "next/server";
import { agencyIds } from "../../../../../src/server/agency-team-db";
import { initiatePayout, listPayouts, verifiedMembers } from "../../../../../src/domain/team-payout";
import { getActor } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { csrfGuard } from "../../../../../src/server/csrf";
import { withApi } from "../../../../../src/server/api/with-api";
import { emailPayout, getPayoutProvider, getTeamPayoutRepo } from "../../../../../src/server/team-payout-db";

type Ctx = { params: Promise<{ id: string }> };

/** Managers see the team's payouts; others only their own. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await listPayouts(getTeamPayoutRepo(), actor, (await params).id);
  if (!r.ok) return failure(r);
  const users = (new URL(req.url).searchParams.get("users") ?? "").split(",");
  const verified = await verifiedMembers(getTeamPayoutRepo(), actor, (await params).id, users);
  return NextResponse.json({ payouts: r.value, enabled: getPayoutProvider().enabled(), verifiedUserIds: verified });
}
export const GET = withApi(handleGet);

/** Manager pays an approved commission for real. Body: { commissionId }. Needs payouts switched on and the member verified. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const body = (await req.json().catch(() => null)) as { commissionId?: unknown } | null;
  const r = await initiatePayout(getTeamPayoutRepo(), getPayoutProvider(), actor, (await params).id, typeof body?.commissionId === "string" ? body.commissionId : "", agencyIds, emailPayout);
  return r.ok ? NextResponse.json({ payout: r.value }, { status: 201 }) : failure(r);
}
export const POST = withApi(handlePost);
