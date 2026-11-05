import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { isEmailAddress } from "../../../../src/domain/messaging-settings";
import { cleanInboundEmailText, isAutomatedSender } from "../../../../src/domain/lead-email";
import { converse } from "../../../../src/domain/lead-service";
import { getDb } from "../../../../src/server/context";
import { getLeadDeps } from "../../../../src/server/lead-db";
import { sendNotice } from "../../../../src/server/messaging";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Inbound email for Elena, posted by the mail provider's inbound parse (or a small forwarder) with header x-inbound-secret.
 * Body: { "from": "a@b.com", "text": "...", "headers"?: { "auto-submitted": "..." } }. FAILS CLOSED: 503 until LEAD_EMAIL_INBOUND_SECRET (32+ chars)
 * and LEAD_QUALIFIER=on are set; 401 on a wrong secret. Automated senders (no-reply, bulk, auto-replies) are ignored so Elena never talks to a robot.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["LEAD_EMAIL_INBOUND_SECRET"];
  if (process.env["LEAD_QUALIFIER"] !== "on" || !secret || secret.length < 32) return NextResponse.json({ error: "Email enquiries are not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-inbound-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  if (Number(req.headers.get("content-length") ?? 0) > 64 * 1024) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const b = (await req.json().catch(() => null)) as { from?: unknown; text?: unknown; headers?: unknown } | null;
  const from = typeof b?.from === "string" ? (b.from.match(/<([^>]+)>/)?.[1] ?? b.from).trim().toLowerCase() : "";
  if (!isEmailAddress(from) || typeof b?.text !== "string") return NextResponse.json({ error: "Invalid message." }, { status: 400 });
  const headers = b.headers && typeof b.headers === "object" ? (b.headers as Record<string, unknown>) : {};
  if (isAutomatedSender(from, headers)) return NextResponse.json({ ok: true, ignored: true });
  const text = cleanInboundEmailText(b.text);
  if (!text) return NextResponse.json({ ok: true, ignored: true });
  const r = await converse(await getLeadDeps(), { channel: "email", externalId: from, text, originHash: createHash("sha256").update(`email:${from}`).digest("hex").slice(0, 32) });
  if (r.ok && r.value.reply) await sendNotice(getDb(), "lead_reply", from, { subject: "Re: your property enquiry", text: r.value.reply });
  return NextResponse.json({ ok: true });
}

export const POST = withApi(handlePost);
