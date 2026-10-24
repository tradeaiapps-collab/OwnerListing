import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { sniffMime } from "./file-sniff";

/**
 * In-house photo-ID and selfie images (interim manual review, PROJECT_STATUS "Interim identity check").
 * Pure helpers: metadata stripping, AES-256-GCM sealing, limits and the consent wording. No I/O here.
 */

export type IdImagePart = "front" | "back" | "selfie";
export const ID_IMAGE_PARTS: readonly IdImagePart[] = ["front", "back", "selfie"];
export type IdImageMime = "image/jpeg" | "image/png" | "image/webp";

/** Per image. Phone photos are usually 2 to 6 MB. */
export const MAX_ID_IMAGE_BYTES = 10_000_000;
/** Whole multipart request (three images plus fields), checked from Content-Length before the body is read. */
export const MAX_ID_REQUEST_BYTES = 3 * MAX_ID_IMAGE_BYTES + 100_000;

/** Upload attempts, counted before the body is read (a refused attempt still counts). Product can change the numbers. */
export const ID_IMAGE_RATE = { windowMs: 24 * 60 * 60 * 1000, perUser: 6, perIp: 20 } as const;

/** A reviewer's claim on a submission (and so their image access) lasts this long. */
export const ID_CLAIM_TTL_MS = 30 * 60 * 1000;

/** Draft wording; counsel to confirm. Bump the version whenever the text changes: the version is recorded with each consent. */
export const ID_IMAGE_CONSENT_VERSION = "2026-10-25.v1";
export const ID_IMAGE_CONSENT_TEXT =
  "I agree that OwnerListing may collect photos of my Australian government photo ID and a live selfie to confirm my identity. " +
  "The photos are encrypted, are seen only by the staff member assigned to review my check, are not shared with anyone else, " +
  "and are deleted 7 days after approval or 30 days after rejection. A person compares the photos; no face template is made. " +
  "My document number is never recorded.";

// ---------- key ----------

export class IdImageKeyError extends Error {
  constructor() { super("ID_IMAGE_KEY is missing or not 32 bytes of base64."); this.name = "IdImageKeyError"; }
}

function keyBytes(keyB64: string | undefined): Buffer {
  const k = keyB64?.trim();
  if (!k || !/^[A-Za-z0-9+/]{43}=$/.test(k)) throw new IdImageKeyError();
  const raw = Buffer.from(k, "base64");
  if (raw.length !== 32) throw new IdImageKeyError();
  return raw;
}

export function idImageKeyUsable(keyB64: string | undefined): boolean {
  try { keyBytes(keyB64); return true; } catch { return false; }
}

/** Separate sub-key for rate-limit buckets and IP hashes, so the encryption key is never used for anything else. */
export function idImageHmacKey(keyB64: string | undefined): Buffer {
  return createHash("sha256").update("ownerlisting:id-image:hmac:v1").update(keyBytes(keyB64)).digest();
}

// ---------- sealing ----------

const VERSION = 1, IV = 12, TAG = 16;
const aadFor = (submissionId: string, part: IdImagePart, storageKey: string) => Buffer.from(`id-image:v1:${submissionId}:${part}:${storageKey}`);

/** Format: version(1) | iv(12) | tag(16) | ciphertext. A fresh random IV each time. AAD binds it to the submission, part and storage key. */
export function sealIdImage(plain: Uint8Array, keyB64: string | undefined, submissionId: string, part: IdImagePart, storageKey: string): Uint8Array {
  const key = keyBytes(keyB64);
  const iv = randomBytes(IV);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aadFor(submissionId, part, storageKey));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return new Uint8Array(Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), ct]));
}

/** The plaintext, or undefined when tampered with, copied to another row/part/key, or sealed under another key. Throws IdImageKeyError on an unusable key. */
export function openIdImage(sealed: Uint8Array, keyB64: string | undefined, submissionId: string, part: IdImagePart, storageKey: string): Uint8Array | undefined {
  const key = keyBytes(keyB64);
  if (sealed.length < 1 + IV + TAG + 1 || sealed[0] !== VERSION) return undefined;
  const b = Buffer.from(sealed);
  try {
    const d = createDecipheriv("aes-256-gcm", key, b.subarray(1, 1 + IV));
    d.setAAD(aadFor(submissionId, part, storageKey));
    d.setAuthTag(b.subarray(1 + IV, 1 + IV + TAG));
    return new Uint8Array(Buffer.concat([d.update(b.subarray(1 + IV + TAG)), d.final()]));
  } catch {
    return undefined;
  }
}

export const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Random storage key, unrelated to the user or submission: id/<32 hex>/<32 hex>. */
export const newIdImageStorageKey = () => `id/${randomBytes(16).toString("hex")}/${randomBytes(16).toString("hex")}`;

// ---------- type check and metadata stripping ----------

export type CleanResult = { ok: true; mime: IdImageMime; bytes: Uint8Array } | { ok: false; error: string };

const bad = (error: string): CleanResult => ({ ok: false, error });
const TYPE_ERROR = "Use a JPEG, PNG or WebP photo. On iPhone, choose \"Most Compatible\" in Camera settings or take the photo from this page.";
const ascii = (b: Uint8Array, s: number, n: number) => (s + n <= b.length ? String.fromCharCode(...b.subarray(s, s + n)) : "");
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const find = (hay: Uint8Array, needle: string) => Buffer.from(hay).indexOf(Buffer.from(needle, "latin1")) !== -1;

/** JPEG: drop every APPn except JFIF (APP0), ICC profile (APP2) and Adobe (APP14), and all comments. Lossless (no re-encode). */
function cleanJpeg(b: Uint8Array): CleanResult {
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  for (;;) {
    if (i + 4 > b.length || b[i] !== 0xff) return bad("The photo file is damaged.");
    let m = i + 1;
    while (m < b.length && b[m] === 0xff) m++;
    const marker = b[m]!;
    const lenAt = m + 1;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || lenAt + 2 > b.length) {
      return bad("The photo file is damaged.");
    }
    const len = (b[lenAt]! << 8) | b[lenAt + 1]!;
    if (len < 2 || lenAt + len > b.length) return bad("The photo file is damaged.");
    if (marker === 0xda) { out.push(new Uint8Array([0xff, 0xda]), b.subarray(lenAt)); break; }
    const body = b.subarray(lenAt + 2, lenAt + len);
    const keep =
      (marker < 0xe0 || marker > 0xef) && marker !== 0xfe
        ? true
        : (marker === 0xe0 && (ascii(body, 0, 5) === "JFIF\0" || ascii(body, 0, 5) === "JFXX\0"))
          || (marker === 0xe2 && ascii(body, 0, 12) === "ICC_PROFILE\0")
          || (marker === 0xee && ascii(body, 0, 5) === "Adobe");
    if (keep) out.push(new Uint8Array([0xff, marker]), b.subarray(lenAt, lenAt + len));
    i = lenAt + len;
  }
  const clean = concat(out);
  // Metadata segments after the first scan are not expected; refuse rather than keep them.
  if (find(clean, "Exif\0\0") || find(clean, "http://ns.adobe.com/xap/")) return bad("This photo has location or camera data we cannot remove. Take a new photo from this page.");
  return { ok: true, mime: "image/jpeg", bytes: clean };
}

const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "cHRM", "gAMA", "iCCP", "sBIT", "sRGB", "pHYs", "bKGD", "hIST", "sPLT", "cICP"]);

/** PNG: keep image chunks only; text, eXIf, time and unknown ancillary chunks are dropped. Unknown critical chunks are refused. */
function cleanPng(b: Uint8Array): CleanResult {
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8, sawEnd = false;
  while (i + 12 <= b.length) {
    const len = Buffer.from(b.subarray(i, i + 4)).readUInt32BE(0);
    const type = ascii(b, i + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type) || i + 12 + len > b.length) return bad("The photo file is damaged.");
    if (PNG_KEEP.has(type)) out.push(b.subarray(i, i + 12 + len));
    else if (type[0]! >= "A" && type[0]! <= "Z") return bad("The photo file is damaged.");
    i += 12 + len;
    if (type === "IEND") { sawEnd = true; break; }
  }
  if (!sawEnd || out.length < 3) return bad("The photo file is damaged.");
  return { ok: true, mime: "image/png", bytes: concat(out) };
}

/** WebP: drop EXIF and XMP chunks, clear their VP8X flags and fix the RIFF size. Animated WebP is refused. */
function cleanWebp(b: Uint8Array): CleanResult {
  const total = Buffer.from(b.subarray(4, 8)).readUInt32LE(0) + 8;
  if (total > b.length || total < 12) return bad("The photo file is damaged.");
  const out: Uint8Array[] = [];
  let i = 12, image = false;
  while (i + 8 <= total) {
    const type = ascii(b, i, 4);
    const size = Buffer.from(b.subarray(i + 4, i + 8)).readUInt32LE(0);
    const end = i + 8 + size + (size % 2);
    if (end > total) return bad("The photo file is damaged.");
    if (type === "ANIM" || type === "ANMF") return bad(TYPE_ERROR);
    if (type === "VP8 " || type === "VP8L") image = true;
    if (type !== "EXIF" && type !== "XMP ") {
      const chunk = new Uint8Array(b.subarray(i, end));
      if (type === "VP8X" && size >= 1) chunk[8] = chunk[8]! & ~0x0c;
      out.push(chunk);
    }
    i = end;
  }
  if (!image) return bad("The photo file is damaged.");
  const body = concat(out);
  const head = new Uint8Array(12);
  head.set(b.subarray(0, 4));
  Buffer.from(head.buffer).writeUInt32LE(body.length + 4, 4);
  head.set(b.subarray(8, 12), 8);
  return { ok: true, mime: "image/webp", bytes: concat([head, body]) };
}

/**
 * Checks the real type from the bytes and removes location, camera and other metadata without re-encoding.
 * Only JPEG, PNG and WebP are accepted; HEIC and everything else are refused. The declared type and filename are ignored.
 */
export function cleanIdImage(bytes: Uint8Array): CleanResult {
  if (bytes.length === 0) return bad("A photo is missing.");
  if (bytes.length > MAX_ID_IMAGE_BYTES) return bad(`Each photo must be under ${MAX_ID_IMAGE_BYTES / 1_000_000} MB.`);
  const mime = sniffMime(bytes);
  const r = mime === "image/jpeg" ? cleanJpeg(bytes) : mime === "image/png" ? cleanPng(bytes) : mime === "image/webp" ? cleanWebp(bytes) : bad(TYPE_ERROR);
  if (r.ok && sniffMime(r.bytes) !== r.mime) return bad("The photo file is damaged.");
  return r;
}

// ---------- reviewer claim ----------

export interface ClaimState { userId: string; status: string; approvals: readonly string[]; assignedTo: string | null; assignedAt: string | null }

/** Whether `staffId` holds a live claim (and so may view images and approve). */
export function holdsClaim(c: ClaimState, staffId: string, nowMs: number): boolean {
  return c.status === "pending" && c.userId !== staffId && c.assignedTo === staffId
    && c.assignedAt !== null && nowMs - Date.parse(c.assignedAt) < ID_CLAIM_TTL_MS;
}

/** A reviewer may claim a pending submission that is not their own, that they have not already approved, and that nobody else holds now. */
export function canClaim(c: ClaimState, staffId: string, nowMs: number): { ok: true } | { ok: false; status: number; error: string } {
  if (c.userId === staffId) return { ok: false, status: 403, error: "Staff cannot review their own identity check." };
  if (c.status !== "pending") return { ok: false, status: 409, error: "This submission is not waiting for review." };
  if (c.approvals.includes(staffId)) return { ok: false, status: 409, error: "A different reviewer must give the second approval." };
  const heldByOther = c.assignedTo !== null && c.assignedTo !== staffId && c.assignedAt !== null && nowMs - Date.parse(c.assignedAt) < ID_CLAIM_TTL_MS;
  if (heldByOther) return { ok: false, status: 409, error: "Another reviewer is working on this check." };
  return { ok: true };
}
