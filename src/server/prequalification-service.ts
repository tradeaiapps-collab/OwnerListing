import { createHash, randomUUID } from "node:crypto";
import type { MalwareScanPort } from "../adapters/malware-scan";
import type { ObjectStoragePort } from "../adapters/object-storage";
import { sniffMime } from "../domain/file-sniff";
import { assess, extractPreapproval, type BuyerDetails, type ConditionCode, type Extracted } from "../domain/prequalification";
import type { Queryable } from "./db";
import { countRecentUploads, insertPrequal, publishedListing } from "./prequalification-db";

export const MAX_PREQUAL_BYTES = 10_000_000;
export const MAX_PREQUALS_PER_DAY = 10;
const DAY_MS = 86_400_000;

export interface PrequalDeps {
  db: Queryable;
  storage: ObjectStoragePort;
  scanner: MalwareScanPort;
  /** PDF bytes to text. A scanned letter (no text) answers ok: false and goes to staff unread. */
  extract: (bytes: Uint8Array, contentType: string) => Promise<{ ok: true; text: string } | { ok: false; message: string }>;
  now: () => string;
}
export type SubmitResult =
  | { ok: true; value: { id: string } }
  | { ok: false; code: "invalid" | "not_found" | "rate_limited" | "unavailable"; message: string };
const fail = (code: "invalid" | "not_found" | "rate_limited" | "unavailable", message: string): SubmitResult => ({ ok: false, code, message });

/**
 * A buyer adds a pre-approval PDF. Order: provider readiness, daily limit, listing check, content checks (real type from the bytes),
 * malware scan, store bytes under a random key, Elena reads the text, record as pending review. Fails closed.
 * What the buyer typed wins over what Elena read; whatever they left out is filled from the letter. Staff confirm everything.
 */
export async function submitPrequalification(d: PrequalDeps, buyerId: string, bytes: Uint8Array, declaredMime: string, details: BuyerDetails): Promise<SubmitResult> {
  if (!d.storage.configured || !d.scanner.configured) return fail("unavailable", "Pre-approval upload is not available yet.");
  const now = d.now();
  if (await countRecentUploads(d.db, buyerId, new Date(Date.parse(now) - DAY_MS).toISOString()) >= MAX_PREQUALS_PER_DAY) {
    return fail("rate_limited", "You have added a lot of pre-approvals today. Try again tomorrow.");
  }
  let listingPrice: number | undefined;
  if (details.listingId) {
    const l = await publishedListing(d.db, details.listingId);
    if (!l) return fail("not_found", "Listing not found.");
    listingPrice = l.priceCents ?? undefined;
  }
  if (bytes.length === 0 || bytes.length > MAX_PREQUAL_BYTES) return fail("invalid", "The letter must be a PDF under 10 MB.");
  if (declaredMime !== "application/pdf" || sniffMime(bytes) !== "application/pdf") return fail("invalid", "Upload the pre-approval letter as a PDF.");
  try {
    if ((await d.scanner.scan(bytes)) !== "clean") return fail("invalid", "The file did not pass the security scan.");
  } catch { return fail("unavailable", "Pre-approval upload is not available right now."); }

  const id = randomUUID();
  const storageKey = `prequal/${buyerId}/${randomUUID()}`;
  try { await d.storage.put(storageKey, bytes, "application/pdf"); } catch { return fail("unavailable", "Pre-approval upload is not available right now."); }

  const ex = await d.extract(bytes, "application/pdf").catch(() => ({ ok: false as const, message: "unreadable" }));
  const read: Extracted | null = ex.ok ? extractPreapproval(ex.text) : null;
  const conditions: ConditionCode[] = details.conditions.length ? details.conditions : (read?.conditions ?? []);
  const approvedCents = details.approvedCents ?? read?.approvedCents;
  const expiresAt = read?.expiresOn ? `${read.expiresOn}T23:59:59.000Z` : undefined;
  const a = assess({ approvedCents, conditions, expiresAt, lender: read?.lender, now, priceCents: listingPrice });
  if (!read) a.flags.push({ code: "unreadable", text: "Elena could not read text in this letter (it may be a scan). Staff will read it." });
  try {
    await insertPrequal(d.db, {
      id, buyerId, listingId: details.listingId, storageKey, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length,
      approvedCents, ratePercent: details.ratePercent ?? read?.ratePercent, termYears: details.termYears ?? read?.termYears, conditions, expiresAt,
      shareWithSellers: details.shareWithSellers, extracted: read ? { ...read, ...(approvedCents !== undefined ? { approvedCents } : {}), conditions } : null, assessment: a, now
    });
  } catch {
    // Storage has no delete for this kind of file; the orphaned key is not referenced by any record and is never served.
    console.error(`prequalification upload: record insert failed, orphaned storage key ${storageKey}`);
    return fail("unavailable", "Pre-approval upload is not available right now.");
  }
  return { ok: true, value: { id } };
}
