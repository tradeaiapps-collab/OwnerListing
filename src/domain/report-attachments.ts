export interface EmailAttachment { filename: string; content: Buffer; contentType: string }
/** Largest total attachment size handed to the mail provider. Above it the attachment is skipped and the email carries the link. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "report";

/** `report-{type}-{period}-{date}.{ext}`: type is the report's name, period is from-to-to, date is the day it was sent. */
export function attachmentFileName(type: string, from: string, to: string, sentOn: string, ext: "pdf" | "xlsx"): string {
  return `report-${slug(type)}-${from}-to-${to}-${sentOn}.${ext}`;
}

/**
 * Keeps files, in order, while the running total stays within the limit. A file that would go over is left out (not truncated), and
 * `skipped` says so, so the email can tell the reader the report is too large to attach and point at the link instead.
 */
export function fitAttachments(files: readonly EmailAttachment[], limit = MAX_ATTACHMENT_BYTES): { attachments: EmailAttachment[]; skipped: number } {
  const attachments: EmailAttachment[] = [];
  let total = 0;
  for (const f of files) {
    if (total + f.content.length > limit) continue;
    total += f.content.length; attachments.push(f);
  }
  return { attachments, skipped: files.length - attachments.length };
}

/** The sentence added to a report email about its attachments (empty when there were none to attach). */
export function attachmentNote(attached: readonly EmailAttachment[], skipped: number): string {
  if (skipped > 0) return `This report is too large to attach${attached.length ? " in full" : ""} (over 25 MB), so use the link below to download it.`;
  return attached.length ? `Attached: ${attached.map(a => a.filename).join(", ")}. The link below also works if you prefer it.` : "";
}
