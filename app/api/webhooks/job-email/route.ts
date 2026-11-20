import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { cleanInboundEmailText, isAutomatedSender } from "../../../../src/domain/lead-email";
import { isEmailAddress } from "../../../../src/domain/messaging-settings";
import { getDb } from "../../../../src/server/context";
import { createNotifySender, handleInboundJobEmail } from "../../../../src/server/elena-jobs-db";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Email replies to Elena's job messages, posted by the mail provider's inbound parse (or a small forwarder) with header x-inbound-secret.
 * Body: { "from": "a@b.com", "subject": "...", "text": "...", "verified": true, "headers"?: {...} }. `verified` must be true only when the
 * forwarder confirmed the From address with a DMARC-aligned pass (DKIM or SPF aligned with the From domain, not just the envelope sender); otherwise the reply is logged and ignored. FAILS CLOSED: 503 until
 * JOB_EMAIL_INBOUND_SECRET (32+ chars) is set; 401 on a wrong secret. Automated senders are ignored.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["JOB_EMAIL_INBOUND_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Job email replies are not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-inbound-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  if (Number(req.headers.get("content-length") ?? 0) > 64 * 1024) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const b = (await req.json().catch(() => null)) as { from?: unknown; subject?: unknown; text?: unknown; verified?: unknown; headers?: unknown } | null;
  const from = typeof b?.from === "string" ? (b.from.match(/<([^>]+)>/)?.[1] ?? b.from).trim().toLowerCase() : "";
  if (!isEmailAddress(from) || typeof b?.text !== "string") return NextResponse.json({ error: "Invalid message." }, { status: 400 });
  const headers = b.headers && typeof b.headers === "object" ? (b.headers as Record<string, unknown>) : {};
  if (isAutomatedSender(from, headers)) return NextResponse.json({ ok: true, ignored: true });
  const text = cleanInboundEmailText(b.text);
  if (!text) return NextResponse.json({ ok: true, ignored: true });
  const subject = typeof b.subject === "string" ? b.subject.slice(0, 200) : "";
  const result = await handleInboundJobEmail(getDb(), createNotifySender(getDb()), { from, subject, text, verified: b.verified === true }, new Date().toISOString());
  return NextResponse.json({ ok: true, result });
}

export const POST = withApi(handlePost);
