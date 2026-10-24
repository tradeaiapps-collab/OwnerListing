import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface SessionPayload {
  /** app_user.id */
  uid: string;
  ut: "owner" | "agent" | "buyer";
  /** Expiry, seconds since epoch. */
  exp: number;
}

const b64 = (buf: Buffer) => buf.toString("base64url");
const mac = (data: string, secret: string) => createHmac("sha256", secret).update(data).digest();

export const SESSION_COOKIE = "ol_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

/** Signed, not encrypted: the payload holds only an id, a role and an expiry. */
export function signSession(p: SessionPayload, secret: string): string {
  const body = b64(Buffer.from(JSON.stringify(p)));
  return `${body}.${b64(mac(body, secret))}`;
}

export function verifySession(token: string | undefined, secret: string, nowSeconds: number): SessionPayload | null {
  if (!token || secret.length < 32) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = mac(body, secret);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<SessionPayload>;
    if (typeof p.uid !== "string" || (p.ut !== "owner" && p.ut !== "agent" && p.ut !== "buyer") || typeof p.exp !== "number") return null;
    if (p.exp <= nowSeconds) return null;
    return { uid: p.uid, ut: p.ut, exp: p.exp };
  } catch {
    return null;
  }
}

export const randomToken = () => b64(randomBytes(32));

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
