/**
 * Pure-JS image checks for listing photos: real size from the headers and a metadata strip that never decodes pixels.
 * Supported: JPEG, PNG, WebP. Everything after the end of the image (appended payloads) is dropped too.
 * What is removed: EXIF (GPS, camera, serial numbers, dates), XMP, IPTC/Photoshop, comments, text chunks, MPF extra pictures
 * and embedded thumbnails. What is kept: pixels, colour profile (ICC), JFIF and Adobe colour markers, and for JPEG the
 * orientation only (rewritten as a one-entry EXIF block, so phone photos still display the right way up).
 */
export type PhotoMime = "image/jpeg" | "image/png" | "image/webp";
export interface ImageInfo { mime: PhotoMime; width: number; height: number }
export type StripResult = { ok: true; bytes: Uint8Array; info: ImageInfo } | { ok: false; reason: string };

const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len));
const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
const u32le = (b: Uint8Array, at: number) => b[at]! + (b[at + 1]! << 8) + (b[at + 2]! << 16) + ((b[at + 3]! << 24) >>> 0);
const u24le = (b: Uint8Array, at: number) => b[at]! + (b[at + 1]! << 8) + (b[at + 2]! << 16);
const bad = (reason: string): StripResult => ({ ok: false, reason });

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** EXIF orientation (1-8) from an APP1 "Exif\0\0" payload, or 1 when absent or unreadable. */
export function exifOrientation(app1: Uint8Array): number {
  if (app1.length < 14 || ascii(app1, 0, 6) !== "Exif\0\0") return 1;
  const t = 6;
  const le = ascii(app1, t, 2) === "II";
  if (!le && ascii(app1, t, 2) !== "MM") return 1;
  const r16 = (at: number) => (at + 2 > app1.length ? -1 : le ? app1[at]! | (app1[at + 1]! << 8) : u16be(app1, at));
  const r32 = (at: number) => (at + 4 > app1.length ? -1 : le ? u32le(app1, at) : u32be(app1, at));
  const ifd = t + r32(t + 4);
  const count = r16(ifd);
  if (ifd < t || count < 0) return 1;
  for (let i = 0; i < count && i < 512; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > app1.length) return 1;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/** A fresh APP1 segment holding only the orientation tag (little-endian TIFF, one IFD entry). */
function orientationSegment(o: number): Uint8Array {
  const body = [
    0x45, 0x78, 0x69, 0x66, 0, 0, // "Exif\0\0"
    0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, // "II", 42, IFD at 8
    1, 0, // one entry
    0x12, 0x01, 3, 0, 1, 0, 0, 0, o, 0, 0, 0, // Orientation, SHORT, count 1, value
    0, 0, 0, 0 // no next IFD
  ];
  const len = body.length + 2;
  return Uint8Array.from([0xff, 0xe1, len >> 8, len & 0xff, ...body]);
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function stripJpeg(b: Uint8Array): StripResult {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return bad("Not a JPEG image.");
  const out: Uint8Array[] = [Uint8Array.from([0xff, 0xd8])];
  let orientation = 1, width = 0, height = 0, pos = 2, wroteOrientation = false;
  let sawScan = false;
  for (;;) {
    // Segment mode: expect a marker.
    if (pos >= b.length || b[pos] !== 0xff) return bad("The JPEG file is damaged.");
    while (pos < b.length && b[pos] === 0xff) pos++;
    if (pos >= b.length) return bad("The JPEG file is damaged.");
    const m = b[pos++]!;
    if (m === 0xd9) {
      if (!sawScan) return bad("The JPEG file has no image data.");
      out.push(Uint8Array.from([0xff, 0xd9]));
      break;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { out.push(Uint8Array.from([0xff, m])); continue; }
    if (pos + 2 > b.length) return bad("The JPEG file is damaged.");
    const len = u16be(b, pos);
    if (len < 2 || pos + len > b.length) return bad("The JPEG file is damaged.");
    const seg = b.subarray(pos - 2, pos + len);
    const data = b.subarray(pos + 2, pos + len);
    pos += len;
    let keep = false;
    if (m === 0xe0) keep = data.length >= 5 && ascii(data, 0, 5) === "JFIF\0";
    else if (m === 0xe1) { if (orientation === 1) orientation = exifOrientation(data); }
    else if (m === 0xe2) keep = data.length >= 12 && ascii(data, 0, 12) === "ICC_PROFILE\0";
    else if (m === 0xee) keep = data.length >= 5 && ascii(data, 0, 5) === "Adobe";
    else if ((m >= 0xe3 && m <= 0xef) || m === 0xfe) keep = false;
    else keep = true;
    if (SOF.has(m)) {
      if (data.length < 6) return bad("The JPEG file is damaged.");
      height = u16be(data, 1); width = u16be(data, 3);
    }
    if (m === 0xda && !wroteOrientation) {
      if (orientation !== 1) out.push(orientationSegment(orientation));
      wroteOrientation = true;
    }
    if (keep) out.push(seg);
    if (m !== 0xda) continue;
    sawScan = true;
    // Entropy-coded data: copy until a real marker (not stuffing 00, not a restart marker).
    const start = pos;
    while (pos + 1 < b.length) {
      if (b[pos] === 0xff && b[pos + 1] !== 0x00 && !(b[pos + 1]! >= 0xd0 && b[pos + 1]! <= 0xd7) && b[pos + 1] !== 0xff) break;
      pos++;
    }
    if (pos + 1 >= b.length) return bad("The JPEG file is damaged.");
    out.push(b.subarray(start, pos));
  }
  if (!width || !height) return bad("The JPEG file has no size.");
  const swap = orientation >= 5;
  return { ok: true, bytes: concat(out), info: { mime: "image/jpeg", width: swap ? height : width, height: swap ? width : height } };
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "pHYs", "bKGD", "cICP"]);

function stripPng(b: Uint8Array): StripResult {
  if (b.length < 33 || PNG_SIG.some((v, i) => b[i] !== v)) return bad("Not a PNG image.");
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let pos = 8, width = 0, height = 0, first = true, sawData = false;
  for (;;) {
    if (pos + 12 > b.length) return bad("The PNG file is damaged.");
    const len = u32be(b, pos);
    const type = ascii(b, pos + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type) || len > b.length || pos + 12 + len > b.length) return bad("The PNG file is damaged.");
    if (first && type !== "IHDR") return bad("The PNG file is damaged.");
    if (type === "IHDR") { width = u32be(b, pos + 8); height = u32be(b, pos + 12); }
    if (type === "IDAT") sawData = true;
    const chunk = b.subarray(pos, pos + 12 + len);
    if (PNG_KEEP.has(type)) out.push(chunk);
    else if (type.charCodeAt(0) < 97) return bad("The PNG file uses an unsupported feature."); // unknown critical chunk
    first = false;
    pos += 12 + len;
    if (type === "IEND") break;
  }
  if (!sawData || !width || !height) return bad("The PNG file has no image data.");
  return { ok: true, bytes: concat(out), info: { mime: "image/png", width, height } };
}

function stripWebp(b: Uint8Array): StripResult {
  if (b.length < 20 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return bad("Not a WebP image.");
  const end = 8 + u32le(b, 4);
  if (end > b.length || end < 20) return bad("The WebP file is damaged.");
  const chunks: Uint8Array[] = [];
  let pos = 12, width = 0, height = 0, sawData = false;
  while (pos < end) {
    if (pos + 8 > end) return bad("The WebP file is damaged.");
    const type = ascii(b, pos, 4), len = u32le(b, pos + 4);
    const padded = len + (len & 1);
    if (pos + 8 + len > end) return bad("The WebP file is damaged.");
    const data = b.subarray(pos + 8, pos + 8 + len);
    const chunk = b.subarray(pos, Math.min(pos + 8 + padded, end));
    pos += 8 + padded;
    if (type === "EXIF" || type === "XMP ") continue;
    if (type === "VP8X") {
      if (len < 10) return bad("The WebP file is damaged.");
      width = u24le(data, 4) + 1; height = u24le(data, 7) + 1;
      const copy = new Uint8Array(chunk);
      copy[8] = copy[8]! & ~(0x08 | 0x04); // clear the EXIF and XMP flags
      chunks.push(copy);
      continue;
    }
    if (type === "VP8 ") {
      if (len < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) return bad("The WebP file is damaged.");
      if (!width) { width = (data[6]! | (data[7]! << 8)) & 0x3fff; height = (data[8]! | (data[9]! << 8)) & 0x3fff; }
      sawData = true;
    } else if (type === "VP8L") {
      if (len < 5 || data[0] !== 0x2f) return bad("The WebP file is damaged.");
      if (!width) {
        const bits = u32le(data, 1);
        width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
      }
      sawData = true;
    } else if (type === "ANMF") sawData = true;
    chunks.push(chunk);
  }
  if (!sawData || !width || !height) return bad("The WebP file has no image data.");
  const total = 4 + chunks.reduce((n, c) => n + c.length, 0);
  const head = new Uint8Array(12);
  head.set([0x52, 0x49, 0x46, 0x46, total & 0xff, (total >>> 8) & 0xff, (total >>> 16) & 0xff, (total >>> 24) & 0xff, 0x57, 0x45, 0x42, 0x50]);
  return { ok: true, bytes: concat([head, ...chunks]), info: { mime: "image/webp", width, height } };
}

/** Strips metadata for the given (already sniffed) type. Damaged or unsupported files are refused, never passed through. */
export function stripImageMetadata(bytes: Uint8Array, mime: PhotoMime): StripResult {
  try {
    if (mime === "image/jpeg") return stripJpeg(bytes);
    if (mime === "image/png") return stripPng(bytes);
    return stripWebp(bytes);
  } catch {
    return bad("The image could not be read.");
  }
}
