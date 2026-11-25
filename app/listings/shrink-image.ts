/** Hosting caps a request near 4.5 MB, so large phone photos are scaled down in the browser first. */
export const SHRINK_ABOVE_BYTES = 3_500_000;
const MAX_SIDE = 2800;

/** Returns a smaller JPEG of a big image, or the original file when it is small, not shrinkable, or the browser cannot do it. */
export async function shrinkImage(file: File): Promise<File> {
  if (file.size <= SHRINK_ABOVE_BYTES || typeof createImageBitmap !== "function") return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    for (const q of [0.85, 0.7, 0.55]) {
      const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, "image/jpeg", q));
      if (blob && blob.size <= SHRINK_ABOVE_BYTES) return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
    }
    return file;
  } catch { return file; }
}
