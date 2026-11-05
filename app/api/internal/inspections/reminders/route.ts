import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { KIND_LABELS } from "../../../../../src/domain/inspection";
import { getDb } from "../../../../../src/server/context";
import { getEmailPort } from "../../../../../src/server/messaging";
import { dueNotices, markNoticeSent } from "../../../../../src/server/transaction-db";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Worker tick for inspection emails (confirmation when booked, reminder 24 hours before, cancellation), called by a scheduler with header
 * x-cron-secret. FAILS CLOSED: 503 while INSPECTION_CRON_SECRET is unset or under 32 characters; 401 on any mismatch (constant-time digest compare).
 * A notice is marked sent only after the email port accepts it; if email is not configured nothing is marked, so it goes out once it is.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();
const WHEN = new Intl.DateTimeFormat("en-AU", { dateStyle: "full", timeStyle: "short", timeZone: "Australia/Brisbane" });

async function handlePost(req: Request) {
  const secret = process.env["INSPECTION_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Inspection reminders are not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  const db = getDb(), now = new Date().toISOString();
  const port = await getEmailPort(db, process.env, "inspection-notice");
  const counts = { sent: 0, failed: 0, not_configured: 0 };
  if (!port.configured) return NextResponse.json({ counts: { ...counts, not_configured: (await dueNotices(db, now)).length } });
  for (const n of await dueNotices(db, now)) {
    const what = KIND_LABELS[n.inspectionKind].toLowerCase();
    const when = `${WHEN.format(new Date(n.scheduledStart))} (Queensland time)`;
    const lead = n.kind === "confirmation" ? `A ${what} is booked` : n.kind === "reminder" ? `Reminder: a ${what} is tomorrow` : `The ${what} has been cancelled`;
    const text = `Hi ${n.name},\n\n${lead} for ${n.address}${n.kind === "cancellation" ? "" : ` on ${when}`}.\n${n.kind === "confirmation" && n.status === "requested" ? "The inspector still needs to confirm the time.\n" : ""}\nSign in to see the details.`;
    const r = await port.send({ to: n.email, subject: `${lead}`, text });
    if (r.status === "sent") { await markNoticeSent(db, n.id, now); counts.sent++; } else counts.failed++;
  }
  return NextResponse.json({ counts });
}

export const POST = withApi(handlePost);
