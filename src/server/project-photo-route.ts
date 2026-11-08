import { NextResponse } from "next/server";
import type { PhotoSize } from "../domain/listing-photos";

const SIZES: readonly PhotoSize[] = ["thumb", "medium", "full"];

/** ?size=thumb|medium|full (default full), or null for anything else. */
export const sizeParam = (req: Request): PhotoSize | null => {
  const s = new URL(req.url).searchParams.get("size") ?? "full";
  return (SIZES as readonly string[]).includes(s) ? s as PhotoSize : null;
};

/** Project photo bytes: the stored, sniffed type, never cached publicly, and nosniff plus a sandbox CSP so it never runs as a page. */
export function photoResponse(bytes: Uint8Array, contentType: string) {
  return new NextResponse(bytes as BodyInit, {
    headers: {
      "content-type": contentType, "content-length": String(bytes.length), "content-disposition": "inline",
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin", "cache-control": "private, no-store"
    }
  });
}

const EXT: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Project document bytes as a download: stored type, a safe name made from the title, never cached, never run as a page. */
export function documentResponse(bytes: Uint8Array, contentType: string, title: string) {
  const name = `${title.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 80) || "document"}.${EXT[contentType] ?? "bin"}`;
  return new NextResponse(bytes as BodyInit, {
    headers: {
      "content-type": contentType, "content-length": String(bytes.length), "content-disposition": `attachment; filename="${name}"`,
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin", "cache-control": "private, no-store"
    }
  });
}

/** One rendered document page: shown in the page, never as a download, never cached, never run as a page. */
export function pageImageResponse(image: Uint8Array, contentType: string) {
  return new NextResponse(image as BodyInit, {
    headers: {
      "content-type": contentType, "content-length": String(image.length), "content-disposition": "inline",
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin", "cache-control": "private, no-store, max-age=0", "x-robots-tag": "noindex, noarchive"
    }
  });
}
