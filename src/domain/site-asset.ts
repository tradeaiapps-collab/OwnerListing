import { sniffMime } from "./file-sniff";

/**
 * Logo, favicon and home hero photo uploads. The type comes from the bytes; the declared content type must agree and the filename is never used.
 * SVG is refused. The hero photo is cleaned of EXIF/XMP/text metadata (cleanIdImage) before it is checked and stored.
 */
export type SiteAssetName = "logo-light" | "logo-dark" | "favicon" | "hero";
export const SITE_ASSET_NAMES: readonly SiteAssetName[] = ["logo-light", "logo-dark", "favicon", "hero"];
export const MAX_ASSET_BYTES = 512 * 1024;
/** The hero is a full-width photo, so it may be larger (keep in step with the CHECK in db/20261025160000_hero_and_guide_assistant.sql). */
export const MAX_HERO_BYTES = 1536 * 1024;
export const maxAssetBytes = (name: SiteAssetName): number => (name === "hero" ? MAX_HERO_BYTES : MAX_ASSET_BYTES);
export type AssetMime = "image/png" | "image/jpeg" | "image/webp" | "image/x-icon";

const MAX_DIM: Record<SiteAssetName, number> = { "logo-light": 2000, "logo-dark": 2000, favicon: 512, hero: 4000 };
/** A hero narrower than this would look blurred across a desktop screen. */
const HERO_MIN_WIDTH = 1200;
const MIN_DIM = 16;

export type AssetCheck = { ok: true; contentType: AssetMime; width: number; height: number } | { ok: false; error: string };
const bad = (error: string): AssetCheck => ({ ok: false, error });

const ascii = (b: Uint8Array, s: number, n: number) => String.fromCharCode(...b.subarray(s, s + n));
const u16le = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u32be = (b: Uint8Array, o: number) => (b[o] ?? 0) * 2 ** 24 + ((b[o + 1] ?? 0) << 16) + ((b[o + 2] ?? 0) << 8) + (b[o + 3] ?? 0);

function pngSize(b: Uint8Array): [number, number] | null {
  return b.length >= 24 && ascii(b, 12, 4) === "IHDR" ? [u32be(b, 16), u32be(b, 20)] : null;
}
function jpegSize(b: Uint8Array): [number, number] | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (len < 2) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [(b[i + 7]! << 8) | b[i + 8]!, (b[i + 5]! << 8) | b[i + 6]!];
    i += 2 + len;
  }
  return null;
}
function webpSize(b: Uint8Array): [number, number] | null {
  const kind = ascii(b, 12, 4);
  if (kind === "VP8 " && b.length >= 30) return [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff];
  if (kind === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
    return [(b[21]! | ((b[22]! & 0x3f) << 8)) + 1, ((b[22]! >> 6) | (b[23]! << 2) | ((b[24]! & 0x0f) << 10)) + 1];
  }
  if (kind === "VP8X" && b.length >= 30) return [(b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1, (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1];
  return null;
}
function icoSize(b: Uint8Array): [number, number] | null {
  if (b.length < 22 || b[0] !== 0 || b[1] !== 0 || b[2] !== 1 || b[3] !== 0) return null;
  const n = u16le(b, 4);
  if (n < 1 || n > 16 || b.length < 6 + n * 16) return null;
  let w = 0, h = 0;
  for (let k = 0; k < n; k++) {
    const o = 6 + k * 16;
    const size = (b[o + 8] ?? 0) + ((b[o + 9] ?? 0) << 8) + ((b[o + 10] ?? 0) << 16) + (b[o + 11] ?? 0) * 2 ** 24;
    const off = (b[o + 12] ?? 0) + ((b[o + 13] ?? 0) << 8) + ((b[o + 14] ?? 0) << 16) + (b[o + 15] ?? 0) * 2 ** 24;
    if (size < 1 || off + size > b.length) return null;
    w = Math.max(w, b[o] || 256); h = Math.max(h, b[o + 1] || 256);
  }
  return [w, h];
}

export function inspectSiteAsset(name: unknown, declaredType: unknown, bytes: Uint8Array): AssetCheck {
  if (typeof name !== "string" || !(SITE_ASSET_NAMES as readonly string[]).includes(name)) return bad("Unknown image slot.");
  const slot = name as SiteAssetName;
  if (bytes.length === 0) return bad("The file is empty.");
  if (bytes.length > maxAssetBytes(slot)) return bad(slot === "hero" ? "The file is larger than 1.5 MB." : "The file is larger than 512 KB.");
  const head = ascii(bytes, 0, Math.min(bytes.length, 512)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml") || head.startsWith("<!doctype") || head.includes("<svg")) return bad("SVG images are not accepted. Use PNG, JPEG or WebP.");

  const sniffed = sniffMime(bytes);
  let type: AssetMime | null = null;
  let size: [number, number] | null = null;
  if (sniffed === "image/png") { type = "image/png"; size = pngSize(bytes); }
  else if (sniffed === "image/jpeg") { type = "image/jpeg"; size = jpegSize(bytes); }
  else if (sniffed === "image/webp") { type = "image/webp"; size = webpSize(bytes); }
  else if (sniffed === null && icoSize(bytes)) { type = "image/x-icon"; size = icoSize(bytes); }
  if (!type) return bad("Only PNG, JPEG, WebP or ICO images are accepted.");
  if (type === "image/x-icon" && slot !== "favicon") return bad("ICO is accepted for the favicon only.");

  const declared = typeof declaredType === "string" ? declaredType.split(";")[0]!.trim().toLowerCase() : "";
  const declaredNorm = declared === "image/vnd.microsoft.icon" ? "image/x-icon" : declared;
  if (declaredNorm !== type) return bad("The file content does not match the declared type.");
  if (!size || size[0] < 1 || size[1] < 1) return bad("The image size could not be read.");
  const [w, h] = size;
  if (w < MIN_DIM || h < MIN_DIM) return bad(`The image must be at least ${MIN_DIM} by ${MIN_DIM} pixels.`);
  if (w > MAX_DIM[slot] || h > MAX_DIM[slot]) return bad(`The image must be at most ${MAX_DIM[slot]} by ${MAX_DIM[slot]} pixels.`);
  if (slot === "hero" && (w < HERO_MIN_WIDTH || w < h)) return bad(`The hero photo must be landscape and at least ${HERO_MIN_WIDTH} pixels wide.`);
  return { ok: true, contentType: type, width: w, height: h };
}
