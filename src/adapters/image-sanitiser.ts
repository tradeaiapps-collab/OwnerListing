import type { PhotoMime } from "../domain/image-meta";

/**
 * Serverless-safe replacement for a virus scan, for IMAGES only. The picture is decoded and written out again, so
 * metadata and anything appended to or hidden inside the file does not survive: only pixels reach storage.
 * It never covers PDFs or other documents; those stay refused until a real scanner (ClamAV) is configured.
 */
export interface ImageSanitiserPort {
  readonly available: boolean;
  /** Same format out as in. Throws on anything that does not decode cleanly (corrupt, truncated, too many pixels). */
  sanitise(bytes: Uint8Array, mime: PhotoMime): Promise<Uint8Array>;
}

export const noSanitiser: ImageSanitiserPort = { available: false, async sanitise() { throw new Error("Image sanitiser is not configured."); } };

const MAX_PIXELS = 60_000_000;

interface SharpInstance { rotate(): SharpInstance; jpeg(o: object): SharpInstance; png(o: object): SharpInstance; webp(o: object): SharpInstance; toBuffer(): Promise<Uint8Array> }
type SharpFn = (input: Uint8Array, opts: { limitInputPixels: number; failOn: string }) => SharpInstance;

/**
 * IMAGE_SANITISER=sharp turns it on (needs the sharp library, a dependency of this app). Anything else, or a library
 * that will not load, leaves it off, so uploads fail closed unless ClamAV is configured.
 */
export async function imageSanitiserFromEnv(env: Readonly<Record<string, string | undefined>>): Promise<ImageSanitiserPort> {
  if (env.IMAGE_SANITISER !== "sharp") return noSanitiser;
  let sharp: SharpFn;
  try {
    const name = "sharp";
    const mod = await import(/* webpackIgnore: true */ name) as { default?: SharpFn };
    if (typeof mod.default !== "function") return noSanitiser;
    sharp = mod.default;
  } catch {
    return noSanitiser;
  }
  return {
    available: true,
    async sanitise(bytes, mime) {
      // No withMetadata(): EXIF, GPS, XMP, comments and the colour profile are all dropped. rotate() applies the orientation first.
      const img = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "error" }).rotate();
      const out = mime === "image/jpeg" ? img.jpeg({ quality: 88 }) : mime === "image/png" ? img.png({ compressionLevel: 9 }) : img.webp({ quality: 88 });
      const result = new Uint8Array(await out.toBuffer());
      if (result.length === 0) throw new Error("Image did not re-encode.");
      return result;
    }
  };
}
