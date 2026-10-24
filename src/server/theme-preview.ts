import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived signed token that lets the public site show the unpublished draft theme. Only a staff member with theme.edit can get one
 * (POST /api/staff/site/preview). It carries who and when, nothing else, and verifies only as a preview token (domain-separated key).
 */
export const PREVIEW_TTL_SECONDS = 15 * 60;
export const PREVIEW_PARAM = "theme_preview";
const MAX_TOKEN = 400;

const mac = (data: string, secret: string) => createHmac("sha256", `${secret}:theme-preview:v1`).update(data).digest();

export function signPreviewToken(p: { uid: string; exp: number }, secret: string): string {
  const body = Buffer.from(JSON.stringify({ uid: p.uid, exp: p.exp })).toString("base64url");
  return `${body}.${mac(body, secret).toString("base64url")}`;
}

export function verifyPreviewToken(token: string | null | undefined, secret: string | undefined, nowSeconds: number): { uid: string } | null {
  if (!token || token.length > MAX_TOKEN || !secret || secret.length < 32) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = mac(body, secret);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { uid?: unknown; exp?: unknown };
    if (typeof p.uid !== "string" || typeof p.exp !== "number" || !(p.exp > nowSeconds) || p.exp > nowSeconds + PREVIEW_TTL_SECONDS + 60) return null;
    return { uid: p.uid };
  } catch {
    return null;
  }
}
