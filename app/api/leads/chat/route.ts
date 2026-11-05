import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { converse } from "../../../../src/domain/lead-service";
import { getLeadDeps, originHashOf } from "../../../../src/server/lead-db";
import { failure } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Elena's public qualifier chat. No sign-in: the visitor gets a random token on the first message and sends it back to continue. Only its hash is stored.
 * Body: { "message": "...", "token"?: "..." }. New conversations are limited per network origin per hour (hashed, never stored raw).
 */
async function handlePost(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > 8 * 1024) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const body = (await req.json().catch(() => null)) as { message?: unknown; token?: unknown } | null;
  if (!body || typeof body.message !== "string") return NextResponse.json({ error: "Send a message." }, { status: 400 });
  const token = typeof body.token === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(body.token) ? body.token : randomBytes(24).toString("base64url");
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || null;
  const r = await converse(await getLeadDeps(), {
    channel: "chat", externalId: createHash("sha256").update(token).digest("hex"), text: body.message, originHash: originHashOf(ip)
  });
  if (!r.ok) return failure(r);
  const { leadId: _leadId, ...out } = r.value;
  return NextResponse.json({ ...out, token }, { headers: { "cache-control": "no-store" } });
}

export const POST = withApi(handlePost);
