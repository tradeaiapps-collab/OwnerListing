/** Duplicate detection for files picked in the browser. Two files are the same when size and content hash match; the name is ignored, so a renamed copy is caught too. */
export interface FileId { name: string; size: number; digest: string }

export const fileIdentity = (f: Pick<FileId, "size" | "digest">): string => `${f.size}:${f.digest}`;

/** Splits incoming files into new ones and repeats. A repeat is a file whose name matches one already held (ignoring case), or whose size and content hash match (a renamed copy).
 * Also a repeat when it appears earlier in the same batch. Order is kept. */
export function splitDuplicates<T extends FileId>(held: readonly FileId[], incoming: readonly T[]): { fresh: T[]; skipped: T[] } {
  const ids = new Set(held.map(fileIdentity));
  const names = new Set(held.map(f => f.name.toLowerCase()));
  const fresh: T[] = [], skipped: T[] = [];
  for (const f of incoming) {
    const id = fileIdentity(f), n = f.name.toLowerCase();
    if (ids.has(id) || names.has(n)) skipped.push(f); else { ids.add(id); names.add(n); fresh.push(f); }
  }
  return { fresh, skipped };
}

/** A short, plain note for the owner. */
export function skippedNote(skipped: readonly Pick<FileId, "name">[]): string {
  if (skipped.length === 0) return "";
  return skipped.length === 1 ? `Skipped ${skipped[0]!.name}: already added.` : `Skipped ${skipped.length} files: already added.`;
}
