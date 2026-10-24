import { createHmac, randomUUID } from "node:crypto";
import type { MalwareScanPort } from "../adapters/malware-scan";
import type { ObjectStoragePort } from "../adapters/object-storage";
import {
  ID_IMAGE_CONSENT_VERSION, ID_IMAGE_PARTS, ID_IMAGE_RATE, cleanIdImage, canClaim, holdsClaim, idImageHmacKey, idImageKeyUsable,
  newIdImageStorageKey, openIdImage, sealIdImage, sha256Hex, type ClaimState, type IdImageMime, type IdImagePart
} from "../domain/id-image";
import { RETAIN_IMAGE_DAYS, canSubmitAgain, validateSubmission, type IdDocumentKind } from "../domain/id-verification";
import type { Failure, Result } from "../domain/listing-service";
import { withinLimit } from "../domain/rate-limit";

export type IdImageEvent =
  | "submitted" | "refused" | "rate_limited" | "scan_infected" | "store_failed" | "claimed" | "integrity_failed" | "images_deleted" | "delete_failed";

export interface StoredImage { key: string; sha256: string; mime: IdImageMime }
export interface NewSubmission {
  id: string; userId: string; documentKind: IdDocumentKind; documentCountry: string; expiryDate: string;
  selfieCapturedInApp: boolean; consentVersion: string; images: Partial<Record<IdImagePart, StoredImage>>;
}
export interface ReviewState extends ClaimState { parts: IdImagePart[]; deleted: boolean }

/** Storage for the flow. Postgres version: id-image-db.ts; tests use an in-memory one. Every write to a log is insert-only. */
export interface IdImageStore {
  hit(bucket: string, windowMs: number): Promise<number | undefined>;
  buyerState(userId: string): Promise<{ emailVerified: boolean; phoneVerified: boolean; idVerified: boolean; pending: boolean; recentSubmittedAt: string[] }>;
  recordConsent(userId: string, version: string): Promise<void>;
  /** Status of the buyer's latest submission, or null. Status only. */
  latestStatus(userId: string): Promise<string | null>;
  /** False when the buyer already has a submission waiting (unique index); nothing is inserted then. */
  insertSubmission(s: NewSubmission): Promise<boolean>;
  log(e: { event: IdImageEvent; userId?: string; submissionId?: string; staffId?: string; ipHash?: string }): Promise<void>;
  reviewState(submissionId: string): Promise<ReviewState | null>;
  /** Atomic: true only if the claim rules still hold at write time. */
  claim(submissionId: string, staffId: string, ttlMs: number): Promise<boolean>;
  image(submissionId: string, part: IdImagePart): Promise<StoredImage | null>;
  /**
   * Audit row in id_review_access: "view" is written before storage is read (must succeed before any byte is shown);
   * "shown" after the image decrypted and passed its hash check, just before it is sent.
   */
  recordView(submissionId: string, staffId: string, part: IdImagePart, stage: "view" | "shown"): Promise<void>;
  /** Parts actually shown (stage "shown") to this reviewer since the time given. A view that failed does not count. */
  viewedParts(submissionId: string, staffId: string, sinceIso: string): Promise<IdImagePart[]>;
  dueForDeletion(approvedBeforeIso: string, rejectedBeforeIso: string, limit: number): Promise<{ id: string; userId: string; keys: string[] }[]>;
  /** Clears keys and hashes and sets images_deleted_at; logs images_deleted. */
  markDeleted(submissionId: string): Promise<boolean>;
}

export interface IdImageDeps {
  store: IdImageStore; storage: ObjectStoragePort; scanner: MalwareScanPort; key: string | undefined;
  /** ID_RETENTION_CRON_SECRET: no images are collected unless the retention job can run. */
  retentionSecret: string | undefined;
  now?: () => number;
}

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const OFF = fail("unavailable", "ID photo upload is not available yet.");
const NOT_FOUND = fail("not_found", "Not found.");
const nowMs = (d: IdImageDeps) => (d.now ?? Date.now)();

/**
 * Every piece must be configured: storage that can delete, the malware scanner, a 32-byte key and the retention job's
 * secret (so images are deleted on schedule). Otherwise nothing is collected, shown or approved.
 */
export function idImagesReady(d: Pick<IdImageDeps, "storage" | "scanner" | "key" | "retentionSecret">): boolean {
  return d.storage.configured && typeof d.storage.remove === "function" && d.scanner.configured && idImageKeyUsable(d.key)
    && typeof d.retentionSecret === "string" && d.retentionSecret.length >= 32;
}

const keyed = (d: IdImageDeps, v: string) => createHmac("sha256", idImageHmacKey(d.key)).update(v).digest("hex");

/**
 * Cheap checks before the body is read (called by submitIdImages): configured, buyer state, no submission waiting, daily submissions, and the
 * per-user and per-IP attempt limits (a refused attempt still counts; a counter error counts as over the limit).
 */
async function precheckIdUpload(d: IdImageDeps, userId: string, ip: string): Promise<Failure | null> {
  if (!idImagesReady(d)) return OFF;
  const ipHash = keyed(d, `ip:${ip}`);
  let within = true;
  for (const [bucket, limit] of [[`id-upload:user:${userId}`, ID_IMAGE_RATE.perUser], [`id-upload:ip:${ip}`, ID_IMAGE_RATE.perIp]] as const) {
    if (!withinLimit(await d.store.hit(keyed(d, bucket), ID_IMAGE_RATE.windowMs), limit)) within = false;
  }
  if (!within) {
    await d.store.log({ event: "rate_limited", userId, ipHash });
    return fail("rate_limited", "Too many attempts. Try again tomorrow.");
  }
  const s = await d.store.buyerState(userId);
  if (!s.emailVerified || !s.phoneVerified) return fail("forbidden", "Verify your email and mobile first.");
  if (s.idVerified) return fail("conflict", "Your ID is already verified.");
  if (s.pending) return fail("conflict", "Your ID is already waiting for review.");
  if (!canSubmitAgain(s.recentSubmittedAt, new Date(nowMs(d)).toISOString())) return fail("rate_limited", "Too many ID submissions today. Try again tomorrow.");
  return null;
}

export interface IdUploadInput { fields: Readonly<Record<string, string | undefined>>; files: Partial<Record<IdImagePart, Uint8Array>> }

const KINDS: readonly IdDocumentKind[] = ["drivers_licence", "passport", "other_government_id"];

/**
 * Accepts one submission: consent (current wording version) recorded first, Australian document only, real type from the
 * bytes, metadata stripped, malware scan, then each image sealed with AES-256-GCM under ID_IMAGE_KEY and stored under a
 * random key. Document numbers are not accepted as a field and nothing about the images is logged.
 * `read` buffers the request body; it is called only after the pre-checks (so a refused attempt never makes the server read it).
 */
export async function submitIdImages(
  d: IdImageDeps, userId: string, ip: string, read: () => Promise<IdUploadInput | Failure>
): Promise<Result<{ status: "pending" }>> {
  const early = await precheckIdUpload(d, userId, ip);
  if (early) return early;
  const input = await read();
  if ("ok" in input) return input;
  const ipHash = keyed(d, `ip:${ip}`);
  const refuse = async (message: string) => { await d.store.log({ event: "refused", userId, ipHash }); return fail("invalid", message); };
  const f = input.fields;
  if (f["consent"] !== "true" || f["consentVersion"] !== ID_IMAGE_CONSENT_VERSION) return refuse("Please read and tick the privacy notice first.");
  const kind = KINDS.find(k => k === f["documentKind"]);
  if (!kind) return refuse("Choose the type of ID.");
  if (f["documentCountry"] !== "AU") return refuse("Only Australian government photo ID can be checked here.");
  const parts: IdImagePart[] = kind === "passport" ? ["front", "selfie"] : ["front", "back", "selfie"];
  const today = new Date(nowMs(d)).toISOString().slice(0, 10);
  const problems = validateSubmission({
    id: "", userId, documentKind: kind, documentCountry: "AU", expiryDate: f["expiryDate"] ?? "", submittedAt: "", status: "pending", approvals: [],
    selfieCapturedInApp: f["selfieSource"] === "camera",
    ...(input.files.front ? { frontImageRef: "x" } : {}), ...(input.files.back ? { backImageRef: "x" } : {}), ...(input.files.selfie ? { selfieRef: "x" } : {})
  }, today);
  if (problems.length > 0) return refuse(problems[0]!);

  const cleaned: Partial<Record<IdImagePart, { bytes: Uint8Array; mime: IdImageMime }>> = {};
  for (const p of parts) {
    const r = cleanIdImage(input.files[p]!);
    if (!r.ok) return refuse(r.error);
    cleaned[p] = r;
  }
  for (const p of parts) {
    let verdict: "clean" | "infected";
    try { verdict = await d.scanner.scan(cleaned[p]!.bytes); } catch { return fail("unavailable", "ID photo upload is unavailable right now. Try again later."); }
    if (verdict !== "clean") {
      await d.store.log({ event: "scan_infected", userId, ipHash });
      return fail("invalid", "One of the photos could not be accepted. Take new photos from this page.");
    }
  }

  await d.store.recordConsent(userId, ID_IMAGE_CONSENT_VERSION);
  const id = randomUUID();
  const images: Partial<Record<IdImagePart, StoredImage>> = {};
  const removeAll = async () => { for (const s of Object.values(images)) await d.storage.remove!(s.key).catch(() => undefined); };
  try {
    for (const p of parts) {
      const key = newIdImageStorageKey();
      const c = cleaned[p]!;
      images[p] = { key, sha256: sha256Hex(c.bytes), mime: c.mime };
      await d.storage.put(key, sealIdImage(c.bytes, d.key, id, p, key), "application/octet-stream");
    }
  } catch {
    await removeAll();
    await d.store.log({ event: "store_failed", userId, ipHash });
    return fail("unavailable", "ID photo upload is unavailable right now. Try again later.");
  }
  let inserted: boolean;
  try {
    inserted = await d.store.insertSubmission({
      id, userId, documentKind: kind, documentCountry: "AU", expiryDate: f["expiryDate"]!, selfieCapturedInApp: true,
      consentVersion: ID_IMAGE_CONSENT_VERSION, images
    });
  } catch {
    await removeAll();
    return fail("unavailable", "ID photo upload is unavailable right now. Try again later.");
  }
  if (!inserted) {
    await removeAll();
    return fail("conflict", "Your ID is already waiting for review.");
  }
  await d.store.log({ event: "submitted", userId, submissionId: id, ipHash });
  return { ok: true, value: { status: "pending" } };
}

/** A reviewer takes a submission (and so image access) for ID_CLAIM_TTL_MS. Not their own, not one they approved, not one held by someone else. */
export async function claimIdSubmission(d: IdImageDeps, staffId: string, submissionId: string, ttlMs: number): Promise<Result<{ claimed: true }>> {
  if (!idImagesReady(d)) return OFF;
  const s = await d.store.reviewState(submissionId);
  if (!s) return NOT_FOUND;
  const c = canClaim(s, staffId, nowMs(d));
  if (!c.ok) return fail(c.status === 403 ? "forbidden" : "conflict", c.error);
  if (!(await d.store.claim(submissionId, staffId, ttlMs))) return fail("conflict", "Another reviewer is working on this check.");
  await d.store.log({ event: "claimed", submissionId, staffId });
  return { ok: true, value: { claimed: true } };
}

/**
 * Decrypts one image for the reviewer holding the live claim. Everyone else (including the buyer, other reviewers and
 * the submitter if they are staff) gets the same "not found". The view is audited before any byte is read; a failed
 * audit write refuses the view. Tampered or swapped ciphertext and a hash mismatch are refused and logged.
 */
export async function viewIdImage(d: IdImageDeps, staffId: string, submissionId: string, part: string): Promise<Result<{ bytes: Uint8Array; mime: IdImageMime }>> {
  if (!idImagesReady(d)) return OFF;
  const p = ID_IMAGE_PARTS.find(x => x === part);
  if (!p) return NOT_FOUND;
  const s = await d.store.reviewState(submissionId);
  if (!s || s.deleted || !s.parts.includes(p) || !holdsClaim(s, staffId, nowMs(d))) return NOT_FOUND;
  const img = await d.store.image(submissionId, p);
  if (!img) return NOT_FOUND;
  try { await d.store.recordView(submissionId, staffId, p, "view"); } catch { return fail("unavailable", "Could not record the view, so the image is not shown."); }
  let sealed: Uint8Array;
  try { sealed = await d.storage.get(img.key); } catch { return fail("unavailable", "The image could not be read."); }
  const plain = openIdImage(sealed, d.key, submissionId, p, img.key);
  if (!plain || sha256Hex(plain) !== img.sha256) {
    await d.store.log({ event: "integrity_failed", submissionId, staffId });
    return fail("unavailable", "The image failed its integrity check and is not shown.");
  }
  try { await d.store.recordView(submissionId, staffId, p, "shown"); } catch { plain.fill(0); return fail("unavailable", "Could not record the view, so the image is not shown."); }
  return { ok: true, value: { bytes: plain, mime: img.mime } };
}

/** Why this reviewer cannot approve yet (null = may approve): images must be available, the claim live, and every image viewed under it. */
export async function approvalBlocker(d: IdImageDeps, staffId: string, submissionId: string): Promise<string | null> {
  if (!idImagesReady(d)) return "Document images are unavailable, so approval is blocked until image storage is configured.";
  const s = await d.store.reviewState(submissionId);
  if (!s || !holdsClaim(s, staffId, nowMs(d))) return "Claim this check before approving it.";
  const seen = await d.store.viewedParts(submissionId, staffId, s.assignedAt!);
  if (s.parts.length === 0 || !s.parts.every(p => seen.includes(p))) return "Open every image before approving.";
  return null;
}

/**
 * Retention: deletes the encrypted images RETAIN_IMAGE_DAYS after the decision (7 after approval, 30 after rejection or
 * "needs more"; counsel to confirm), then clears the keys and hashes. Only the result is kept. Safe to run repeatedly.
 */
export async function runIdImageRetention(d: Pick<IdImageDeps, "store" | "storage">, nowIso: string, limit = 200): Promise<{ deleted: number; failed: number }> {
  if (!d.storage.configured || typeof d.storage.remove !== "function") throw new Error("Storage cannot delete identity images.");
  const t = Date.parse(nowIso);
  const before = (days: number) => new Date(t - days * 86_400_000).toISOString();
  const due = await d.store.dueForDeletion(before(RETAIN_IMAGE_DAYS.approved), before(RETAIN_IMAGE_DAYS.rejected), limit);
  let deleted = 0, failed = 0;
  for (const row of due) {
    try {
      for (const k of row.keys) await d.storage.remove(k);
      if (await d.store.markDeleted(row.id)) deleted++;
    } catch {
      failed++;
      await d.store.log({ event: "delete_failed", userId: row.userId, submissionId: row.id }).catch(() => undefined);
    }
  }
  return { deleted, failed };
}
