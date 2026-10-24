import { NextResponse } from "next/server";
import { ID_SIGNATURE_HEADER, handleIdCheckWebhook } from "../../../../src/server/id-check";
import { getIdDeps } from "../../../../src/server/verification-context";

/**
 * ID-check provider webhook. Not cookie-authenticated, so no csrfGuard: the HMAC signature (secret from ID_CHECK_WEBHOOK_SECRET)
 * is the authentication. Everything is rejected while the secret is unset.
 */
export async function POST(req: Request) {
  const secret = process.env["ID_CHECK_WEBHOOK_SECRET"];
  if (Number(req.headers.get("content-length") ?? 0) > 16 * 1024) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const reply = await handleIdCheckWebhook(getIdDeps().store, await req.text(), req.headers.get(ID_SIGNATURE_HEADER), secret);
  return NextResponse.json(reply.body, { status: reply.status });
}
