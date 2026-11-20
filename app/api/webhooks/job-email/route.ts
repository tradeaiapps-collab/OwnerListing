import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { formatJobNo } from "../../../../src/domain/contractor-market";
import { sniffMime } from "../../../../src/domain/file-sniff";
import { processJobEmail, type InboundFile } from "../../../../src/domain/job-inbound";
import { isEmailAddress } from "../../../../src/domain/messaging-settings";
import { isAutomatedSender } from "../../../../src/domain/lead-email";
import { uploadDocument } from "../../../../src/domain/document-upload";
import { getDb, getDeps, getUploadPorts } from "../../../../src/server/context";
import { createPgDocumentStore } from "../../../../src/server/documents-db";
import { createPgMarketStore } from "../../../../src/server/contractor-market-db";
import { makeJobNotify } from "../../../../src/server/job-notify";
import { sendNotice } from "../../../../src/server/messaging";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Inbound email for jobs: a contractor replies with JOB-5001 and the files attached. Posted by the mail provider's inbound parse (or a small forwarder)
 * with header x-inbound-secret. Body: { from, subject, text, headers?, attachments: [{ filename, contentType, contentBase64 }] }.
 * FAILS CLOSED: 503 until JOB_EMAIL_INBOUND_SECRET (32+ chars) is set; 401 on a wrong secret. The provider must have checked SPF/DKIM for the From address.
 * Matching and every file check live in src/domain/job-inbound.ts; the files go through the same upload service as the website.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();
const MAX_BODY = 60 * 1024 * 1024;

async function handlePost(req: Request) {
  const secret = process.env["JOB_EMAIL_INBOUND_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "Job email is not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-inbound-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const b = (await req.json().catch(() => null)) as { from?: unknown; subject?: unknown; text?: unknown; headers?: unknown; attachments?: unknown } | null;
  const from = typeof b?.from === "string" ? (b.from.match(/<([^>]+)>/)?.[1] ?? b.from).trim().toLowerCase() : "";
  if (!isEmailAddress(from) || typeof b?.subject !== "string") return NextResponse.json({ error: "Invalid message." }, { status: 400 });
  const headers = b.headers && typeof b.headers === "object" ? (b.headers as Record<string, unknown>) : {};
  if (isAutomatedSender(from, headers)) return NextResponse.json({ ok: true, ignored: true });
  const files: InboundFile[] = [];
  for (const a of Array.isArray(b.attachments) ? (b.attachments as Record<string, unknown>[]).slice(0, 25) : []) {
    if (typeof a?.["contentBase64"] !== "string" || typeof a["filename"] !== "string") continue;
    files.push({ filename: a["filename"], contentType: typeof a["contentType"] === "string" ? a["contentType"] : "", bytes: new Uint8Array(Buffer.from(a["contentBase64"], "base64")) });
  }
  const db = getDb(), store = createPgMarketStore(db), notify = makeJobNotify(db);
  const out = await processJobEmail({
    sniff: b => sniffMime(b) ?? undefined,
    async findJob(no, email) {
      const r = (await db.query("SELECT a.id FROM job_assignment a JOIN app_user c ON c.id = a.contractor_user_id WHERE a.job_number = $1::integer AND c.email = $2::citext AND c.status NOT IN ('suspended','closed')", [no, email])).rows[0];
      return r ? store.getJob(String(r["id"])) : undefined;
    },
    async upload(job, kind, mime, bytes) {
      return uploadDocument(getDeps(), createPgDocumentStore(db), getUploadPorts(), { userId: job.contractorUserId, userType: "vendor" }, job.listingId, { kind, declaredMime: mime, visibility: "parties", bytes });
    },
    notifyOwner: (job, count) => notify(job.ownerUserId, "job_files_added", job, { count: String(count) })
  }, { from, subject: b.subject, text: typeof b.text === "string" ? b.text : "", files });
  await sendNotice(db, "job_files", from, { subject: `Re: ${b.subject}`.slice(0, 200), text: out.reply });
  return NextResponse.json({ ok: true, matched: out.matched, accepted: out.accepted, ...(out.jobNumber !== undefined ? { job: formatJobNo(out.jobNumber) } : {}) });
}

export const POST = withApi(handlePost);
