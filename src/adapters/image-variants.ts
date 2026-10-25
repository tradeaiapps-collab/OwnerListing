import { VARIANT_WIDTH, type PhotoSize } from "../domain/listing-photos";

type VariantSize = Exclude<PhotoSize, "full">;

/** Makes smaller WebP copies of a photo for cards and the gallery. Optional: without it only the full image is served. */
export interface ImageVariantPort {
  readonly available: boolean;
  /** Only sizes narrower than the original are made. Output is re-encoded, so it carries no metadata. */
  make(bytes: Uint8Array, displayWidth: number): Promise<Partial<Record<VariantSize, Uint8Array>>>;
}

export const noVariants: ImageVariantPort = { available: false, async make() { return {}; } };

type SharpFn = (input: Uint8Array, opts: { limitInputPixels: number; failOn: string }) => {
  rotate(): { resize(o: { width: number; withoutEnlargement: boolean }): { webp(o: { quality: number }): { toBuffer(): Promise<Uint8Array> } } };
};

/**
 * Uses the sharp image library when it is installed (Next.js installs it for its own image optimiser); it is not a
 * declared dependency here. IMAGE_VARIANTS=off turns it off. Any failure gives no variants, never a failed upload.
 */
export async function imageVariantsFromEnv(env: Readonly<Record<string, string | undefined>>): Promise<ImageVariantPort> {
  if (env.IMAGE_VARIANTS === "off") return noVariants;
  let sharp: SharpFn;
  try {
    const name = "sharp";
    const mod = await import(/* webpackIgnore: true */ name) as { default?: SharpFn };
    if (typeof mod.default !== "function") return noVariants;
    sharp = mod.default;
  } catch {
    return noVariants;
  }
  return {
    available: true,
    async make(bytes, displayWidth) {
      const out: Partial<Record<VariantSize, Uint8Array>> = {};
      for (const size of Object.keys(VARIANT_WIDTH) as VariantSize[]) {
        const width = VARIANT_WIDTH[size];
        if (width >= displayWidth) continue;
        try {
          out[size] = new Uint8Array(await sharp(bytes, { limitInputPixels: 60_000_000, failOn: "error" })
            .rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer());
        } catch {
          return {};
        }
      }
      return out;
    }
  };
}
