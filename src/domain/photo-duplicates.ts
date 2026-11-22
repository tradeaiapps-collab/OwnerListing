/**
 * Duplicate photo detection. Pure and client-safe (no node imports).
 * A photo is reduced to a 64-bit "difference hash" (dHash) from a 9x8 greyscale grid; two photos are the same shot
 * when their hashes differ by only a few bits. This survives resizing, re-compression and light cropping.
 */
export const HASH_COLS = 9;
export const HASH_ROWS = 8;
/** Bits that may differ (of 64) for two photos to count as the same shot. */
export const DUPLICATE_MAX_DISTANCE = 6;

/** `grey` holds HASH_COLS * HASH_ROWS brightness values, row by row. Returns a 64-character string of 0 and 1. */
export function dHash(grey: ArrayLike<number>): string {
  if (grey.length !== HASH_COLS * HASH_ROWS) throw new Error("Expected a 9x8 greyscale grid.");
  let bits = "";
  for (let y = 0; y < HASH_ROWS; y++) {
    for (let x = 0; x < HASH_COLS - 1; x++) {
      bits += grey[y * HASH_COLS + x]! < grey[y * HASH_COLS + x + 1]! ? "1" : "0";
    }
  }
  return bits;
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

export type DuplicatePair = { first: string; second: string; exact: boolean };

/**
 * Finds photos that repeat an earlier photo. `items` are in gallery order; each pair names the earlier photo (`first`)
 * and the later one (`second`). A later photo is only paired with the first photo it repeats.
 */
export function findDuplicates(items: { id: string; hash: string | null }[]): DuplicatePair[] {
  const out: DuplicatePair[] = [];
  for (let j = 1; j < items.length; j++) {
    const b = items[j]!;
    if (!b.hash) continue;
    for (let i = 0; i < j; i++) {
      const a = items[i]!;
      if (!a.hash) continue;
      const d = hammingDistance(a.hash, b.hash);
      if (d <= DUPLICATE_MAX_DISTANCE) { out.push({ first: a.id, second: b.id, exact: d === 0 }); break; }
    }
  }
  return out;
}
