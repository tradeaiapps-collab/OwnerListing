import { createHmac, timingSafeEqual } from "node:crypto";
import { readCookie } from "./session";

/** Staff identity cookie. It carries only who and when: the staff role is never stored in it, it is read from the database on each request. */
export interface StaffSessionPayload { uid: string; exp: number }

export const STAFF_COOKIE = "ol_staff";
export const STAFF_TTL_SECONDS = 4 * 60 * 60;

// Domain-separated key: a staff token can never verify as a user session, nor the reverse.
const key = (secret: string) => `${secret}:staff-session:v1`;
const mac = (data: string, secret: string) => createHmac("sha256", key(secret)).update(data).digest();

export function signStaffSession(p: StaffSessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify({ uid: p.uid, exp: p.exp })).toString("base64url");
  return `${body}.${mac(body, secret).toString("base64url")}`;
}

export function verifyStaffSession(token: string | undefined, secret: string, nowSeconds: number): StaffSessionPayload | null {
  if (!token || secret.length < 32) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = mac(body, secret);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<StaffSessionPayload>;
    if (typeof p.uid !== "string" || typeof p.exp !== "number" || p.exp <= nowSeconds) return null;
    return { uid: p.uid, exp: p.exp };
  } catch {
    return null;
  }
}

export const staffTokenFromRequest = (req: Request) => readCookie(req, STAFF_COOKIE);
