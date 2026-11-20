import { parseJobNumber, uploadKindFor, formatJobNo } from "./contractor-market";
import type { JobDetail } from "./job-board";
import type { Result } from "./listing-service";

export const MAX_EMAIL_FILES = 10;
export interface InboundFile { filename: string; contentType: string; bytes: Uint8Array }
export interface InboundJobEmail { from: string; subject: string; text: string; files: InboundFile[] }

/** The ports the matching needs. The server wires them to the database, the upload service (type check, malware scan, storage) and notifications. */
export interface InboundJobDeps {
  /** The job with this number, only if the sender's address is the contractor's account address. */
  findJob(jobNumber: number, fromEmail: string): Promise<JobDetail | undefined>;
  /** The normal upload: bytes type-checked, malware scanned, stored, recorded as shared with the parties only. */
  upload(job: JobDetail, kind: NonNullable<ReturnType<typeof uploadKindFor>>, mime: string, bytes: Uint8Array): Promise<Result<{ id: string }> | { ok: false; code: "unavailable"; message: string }>;
  notifyOwner(job: JobDetail, count: number): Promise<void>;
  sniff(bytes: Uint8Array): string | undefined;
}
export interface InboundOutcome { matched: boolean; jobNumber?: number; accepted: number; rejected: { filename: string; reason: string }[]; reply: string }

/**
 * A contractor emails or replies with the job number (JOB-5001) in the subject or text and the files attached. The job is found by that number AND the
 * sender's registered address, the job must be accepted and still open, and every file goes through the same upload checks as the website.
 * Nothing is attached to a job the sender is not the contractor on. The reply text is safe to send back to the sender.
 */
export async function processJobEmail(deps: InboundJobDeps, mail: InboundJobEmail): Promise<InboundOutcome> {
  const no = parseJobNumber(mail.subject) ?? parseJobNumber(mail.text);
  const none = (reply: string): InboundOutcome => ({ matched: false, accepted: 0, rejected: [], reply, ...(no !== undefined ? { jobNumber: no } : {}) });
  if (no === undefined) return none("We could not find a job number. Reply with the job number (for example JOB-5001) in the subject and attach your files again.");
  const job = await deps.findJob(no, mail.from.trim().toLowerCase());
  // One message for unknown number and wrong sender, so the number cannot be used to learn about other people's jobs.
  if (!job) return none(`We could not match ${formatJobNo(no)} to your account. Send from the email address registered on the site, or upload on the website.`);
  const label = formatJobNo(no);
  if (job.status !== "approved") return { ...none(`${label} is not open for files (it is ${job.status === "proposed" ? "waiting for you to accept it" : job.status}). Open the job on the website.`), matched: true };
  if (mail.files.length === 0) return { ...none(`We matched ${label} but there were no attachments. Reply again with the files attached.`), matched: true };

  const rejected: InboundOutcome["rejected"] = [];
  let accepted = 0;
  for (const f of mail.files.slice(0, MAX_EMAIL_FILES)) {
    const real = deps.sniff(f.bytes);
    const kind = real ? uploadKindFor(job.kind, real, `${f.filename} ${mail.subject}`) : undefined;
    if (!real || !kind) { rejected.push({ filename: f.filename, reason: "This file type is not accepted for this job." }); continue; }
    const r = await deps.upload(job, kind, real, f.bytes);
    if (r.ok) accepted++; else rejected.push({ filename: f.filename, reason: r.code === "unavailable" ? "File upload is not available right now. Try again later." : r.message });
  }
  for (const f of mail.files.slice(MAX_EMAIL_FILES)) rejected.push({ filename: f.filename, reason: `At most ${MAX_EMAIL_FILES} files per email.` });
  if (accepted > 0) await deps.notifyOwner(job, accepted);
  const lines = [`${label}: ${accepted} file${accepted === 1 ? "" : "s"} added to the listing and the owner was told.`, ...rejected.map(x => `Not added: ${x.filename.replace(/[\r\n]+/g, " ").slice(0, 80)}: ${x.reason}`)];
  return { matched: true, jobNumber: no, accepted, rejected, reply: lines.join("\n") };
}
