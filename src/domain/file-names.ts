/** Upload file names for the duplicate check. Pure and client-safe. The name is never used as a storage key. */
export const MAX_FILENAME = 200;

/** Base name only (no folders), control characters removed, trimmed, at most 200 characters. Empty when nothing usable is left. */
export function cleanFilename(raw: string | undefined | null): string {
  if (!raw) return "";
  const base = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "").trim().slice(0, MAX_FILENAME);
}

export const sameFilename = (a: string, b: string): boolean => a.length > 0 && a.toLowerCase() === b.toLowerCase();

export const duplicateNameMessage = (name: string): string =>
  `A file named "${name}" is already on this listing. Rename it or choose a different file.`;
