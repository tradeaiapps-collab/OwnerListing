import { PHOTO_LIMITS } from "./listing-photos";
import { sniffMime } from "./file-sniff";

/**
 * Site or floor plan file rules for the browser (pure). A plan is a JPEG, PNG or WebP image, or a PDF.
 * This is a convenience check for the owner; the server repeats it from the file's bytes and scans the file.
 */
export const PLAN_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
/** Matches the server's floor plan cap for documents (src/domain/documents.ts). */
export const PLAN_PDF_MAX_BYTES = 20_000_000;

export const isPdfPlan = (f: { type: string }) => f.type === "application/pdf";

/** Why the file cannot be a plan, or null. `head` is the file's first bytes (at least 12). */
export function planProblem(f: { name: string; type: string; size: number }, head: Uint8Array): string | null {
  if (!(PLAN_MIMES as readonly string[]).includes(f.type)) return `${f.name}: the plan must be a JPEG, PNG, WebP or PDF file.`;
  if (f.size === 0) return `${f.name}: the file is empty.`;
  const pdf = isPdfPlan(f), max = pdf ? PLAN_PDF_MAX_BYTES : PHOTO_LIMITS.maxBytes;
  if (f.size > max) return `${f.name}: larger than ${max / 1_000_000} MB.`;
  if (sniffMime(head) !== f.type) return `${f.name}: the file's contents do not match its type.`;
  return null;
}
