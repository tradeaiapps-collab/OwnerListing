import type { Actor } from "../../domain/listing-service";
import { SESSION_COOKIE, readCookie, verifySession } from "./session";

/** The signed-in user from the session cookie, or null. Fails closed on a missing, forged or expired session. */
export function actorFromRequest(req: Request, secret: string, nowSeconds: number): Actor | null {
  const p = verifySession(readCookie(req, SESSION_COOKIE), secret, nowSeconds);
  return p ? { userId: p.uid, userType: p.ut } : null;
}
