import { NextResponse } from "next/server";
import { agencyIds } from "../../../../src/server/agency-team-db";
import { handleStripeWebhook } from "../../../../src/server/stripe-payouts";
import { emailPayout, getTeamPayoutRepo } from "../../../../src/server/team-payout-db";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Stripe payout webhook. Not cookie-authenticated, so no csrfGuard: the Stripe-Signature HMAC (secret STRIPE_WEBHOOK_SECRET)
 * is the authentication. Everything is rejected while the secret is unset.
 */
async function handlePost(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > 256 * 1024) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const reply = await handleStripeWebhook(
    getTeamPayoutRepo(), await req.text(), req.headers.get("stripe-signature"), process.env["STRIPE_WEBHOOK_SECRET"], agencyIds,
    (userId, p) => getTeamPayoutRepo().userEmail(userId).then(to => (to ? emailPayout(to, p.amountCents, "paid") : undefined))
  );
  return NextResponse.json(reply.body, { status: reply.status });
}

export const POST = withApi(handlePost);
