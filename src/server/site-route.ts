import { NextResponse } from "next/server";
import { validateTheme, type ThemeSettings } from "../domain/site-theme";
import type { SaveOutcome, ThemeView } from "./site-theme-db";
import { fail } from "./staff-route";

export const NO_STORE = { "cache-control": "no-store" } as const;
export const MAX_SETTINGS_BYTES = 64 * 1024;
/** Largest JSON upload body: the 1.5 MB hero photo as base64 plus the other fields. */
export const MAX_UPLOAD_BODY_BYTES = 2100 * 1024;

/** JSON object body with a hard size cap (checked on the declared length and again on the text actually read). */
export async function readBoundedJson(req: Request, maxBytes: number): Promise<Record<string, unknown> | NextResponse> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return fail(413, "The request is too large.");
  const text = await req.text().catch(() => null);
  if (text === null) return fail(400, "Send a JSON object.");
  if (text.length > maxBytes) return fail(413, "The request is too large.");
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(400, "Send a JSON object.");
  } catch {
    return fail(400, "Send a JSON object.");
  }
}

/** A positive integer version, null, or undefined when the value is neither. */
export const versionOrNull = (v: unknown): number | null | undefined =>
  v === null ? null : typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined;

export function parseSettings(v: unknown): { ok: true; value: ThemeSettings } | { ok: false; response: NextResponse } {
  const r = validateTheme(v);
  return r.ok ? r : { ok: false, response: NextResponse.json({ error: "Some settings are not valid.", fields: r.errors }, { status: 400, headers: NO_STORE }) };
}

export async function outcomeResponse(o: SaveOutcome, view: () => Promise<ThemeView>): Promise<NextResponse> {
  if (o.ok) return NextResponse.json(await view(), { headers: NO_STORE });
  return fail(o.code === "conflict" ? 409 : o.code === "not_found" ? 404 : 400, o.error);
}
