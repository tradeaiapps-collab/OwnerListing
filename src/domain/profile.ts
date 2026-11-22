/** Account profile rules (pure). */
export const DISPLAY_NAME_MAX = 80;

export type DisplayNameResult = { ok: true; value: string } | { ok: false; error: string };

export function parseDisplayName(input: unknown): DisplayNameResult {
  const raw = (input as { displayName?: unknown } | null)?.displayName;
  if (typeof raw !== "string") return { ok: false, error: "Enter your name." };
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < 2) return { ok: false, error: "Enter at least 2 characters." };
  if (name.length > DISPLAY_NAME_MAX) return { ok: false, error: `Use ${DISPLAY_NAME_MAX} characters or fewer.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>]/.test(name)) return { ok: false, error: "That name has characters we can't use." };
  return { ok: true, value: name };
}
