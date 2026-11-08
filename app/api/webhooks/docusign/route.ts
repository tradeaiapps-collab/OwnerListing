import { NextResponse } from "next/server";
import { parseConnectEvent, verifyConnectSignature } from "../../../../src/domain/docusign";
import { applyEnvelopeUpdate } from "../../../../src/domain/esign-service";
import { getEsignDeps } from "../../../../src/server/esign";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * DocuSign Connect webhook. Not cookie-authenticated, so no csrfGuard: the HMAC signature (DOCUSIGN_CONNECT_HMAC_KEY) is the
 * authentication, and everything is rejected while that key is unset. A 2xx tells DocuSign we have it; anything else makes it retry,
 * which is what we want while the signed copy cannot be stored yet. Events for envelopes we do not know return 404 (retried, then dropped).
 */
async function handlePost(req: Request) {
  const secret = process.env["DOCUSIGN_CONNECT_HMAC_KEY"] ?? "";
  if (!secret) return NextResponse.json({ error: "Not configured." }, { status: 503 });
  if (Number(req.headers.get("content-length") ?? 0) > 2 * 1024 * 1024) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const raw = await req.text();
  if (raw.length > 2 * 1024 * 1024) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const sig = [1, 2, 3, 4, 5].map(n => req.headers.get(`x-docusign-signature-${n}`));
  if (!verifyConnectSignature(secret, raw, sig)) return NextResponse.json({ error: "Bad signature." }, { status: 401 });
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return NextResponse.json({ error: "Not JSON." }, { status: 400 }); }
  const update = parseConnectEvent(payload);
  if (!update) return NextResponse.json({ ok: true, ignored: true });
  const deps = getEsignDeps();
  if (!deps) return NextResponse.json({ error: "Not configured." }, { status: 503 });
  const r = await applyEnvelopeUpdate(deps, update);
  if (r.ok) return NextResponse.json({ ok: true, status: r.value.status });
  return NextResponse.json({ error: r.message }, { status: r.code === "not_found" ? 404 : 503 });
}

export const POST = withApi(handlePost);
