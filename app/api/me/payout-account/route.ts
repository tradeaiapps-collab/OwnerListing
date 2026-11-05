import { NextResponse } from "next/server";
import { startPayoutOnboarding } from "../../../../src/domain/team-payout";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";
import { csrfGuard } from "../../../../src/server/csrf";
import { withApi } from "../../../../src/server/api/with-api";
import { getPayoutProvider, getTeamPayoutRepo } from "../../../../src/server/team-payout-db";

/** Starts or resumes the caller's payout account. Returns the provider's hosted page for identity and bank details. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const repo = getTeamPayoutRepo();
  const email = await repo.userEmail(actor.userId);
  if (!email) return unauthenticated();
  const base = process.env["APP_URL"] ?? new URL(req.url).origin;
  const body = (await req.json().catch(() => null)) as { teamId?: unknown } | null;
  const back = typeof body?.teamId === "string" && /^[0-9a-f-]{36}$/i.test(body.teamId) ? `${base}/teams/${body.teamId}` : `${base}/teams`;
  const r = await startPayoutOnboarding(repo, getPayoutProvider(), actor, email, { returnUrl: back, refreshUrl: back });
  return r.ok ? NextResponse.json(r.value) : failure(r);
}
export const POST = withApi(handlePost);

/** Verification status only. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const acct = await getTeamPayoutRepo().getAccount(actor.userId);
  return NextResponse.json({ kycStatus: acct?.kycStatus ?? "none", enabled: getPayoutProvider().enabled() });
}
export const GET = withApi(handleGet);
