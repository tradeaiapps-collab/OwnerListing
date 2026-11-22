import { createHash, randomUUID } from "node:crypto";
import type { MalwareScanPort } from "../adapters/malware-scan";
import type { ObjectStoragePort } from "../adapters/object-storage";
import { CERT_MIMES, MAX_CERT_BYTES, MAX_CERTS_PER_DAY, type CertKind } from "../domain/contractor-certificates";
import { sniffMime } from "../domain/file-sniff";
import { addCertificatePg, countRecentCertificatesPg } from "./contractor-certificates-db";
import type { Queryable } from "./db";

export interface CertDeps { db: Queryable; storage: ObjectStoragePort; scanner: MalwareScanPort; now: () => string }
export type CertResult =
  | { ok: true; value: { id: string } }
  | { ok: false; code: "invalid" | "rate_limited" | "forbidden" | "unavailable"; message: string };
const fail = (code: "invalid" | "rate_limited" | "forbidden" | "unavailable", message: string): CertResult => ({ ok: false, code, message });
const DAY_MS = 86_400_000;

/**
 * A contractor adds a licence or insurance certificate (PDF or photo). Order: provider readiness, daily limit, size and type checks (the real type comes
 * from the bytes and must equal the declared one), malware scan, store under a random key (the filename never reaches storage), record. Fails closed.
 * The file does not change the badge by itself: staff compare it with the details in the verification queue.
 */
export async function uploadCertificate(d: CertDeps, userId: string, kind: CertKind, expiry: string, bytes: Uint8Array, declaredMime: string): Promise<CertResult> {
  if (!d.storage.configured || !d.scanner.configured) return fail("unavailable", "Certificate upload is not available yet.");
  if (bytes.length === 0 || bytes.length > MAX_CERT_BYTES) return fail("invalid", "The file must be under 10 MB.");
  const real = sniffMime(bytes);
  if (real === null || !(CERT_MIMES as readonly string[]).includes(real) || real !== declaredMime) return fail("invalid", "Upload a PDF or a photo (JPEG, PNG, WebP or HEIC).");
  if (await countRecentCertificatesPg(d.db, userId, new Date(Date.parse(d.now()) - DAY_MS).toISOString()) >= MAX_CERTS_PER_DAY) {
    return fail("rate_limited", "You have uploaded a lot of certificates today. Try again tomorrow.");
  }
  try { if ((await d.scanner.scan(bytes)) !== "clean") return fail("invalid", "The file did not pass the security scan."); } catch { return fail("unavailable", "Certificate upload is not available right now."); }
  const storageKey = `cert/${userId}/${randomUUID()}`;
  try { await d.storage.put(storageKey, bytes, real); } catch { return fail("unavailable", "Certificate upload is not available right now."); }
  try {
    const id = await addCertificatePg(d.db, { userId, kind, storageKey, sha256: createHash("sha256").update(bytes).digest("hex"), mime: real, sizeBytes: bytes.length, expiry });
    if (!id) return fail("forbidden", "This account cannot upload certificates.");
    return { ok: true, value: { id } };
  } catch {
    // Storage has no delete for this kind of file; the orphaned key is not referenced by any record and is never served.
    console.error(`certificate upload: record insert failed, orphaned storage key ${storageKey}`);
    return fail("unavailable", "Certificate upload is not available right now.");
  }
}
