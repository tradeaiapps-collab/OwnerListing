import type { Actor } from "../../domain/listing-service";
import type { Queryable } from "../db";
import { SESSION_COOKIE, readCookie, verifySession } from "./session";

/**
 * The signed-in user for this request, confirmed against the database now. The cookie is only a claim: the app_user must exist, be
 * active, and have the same user type as the cookie. Anything else (suspended, closed, deleted, retyped) is denied at once.
 */
export async function actorFromRequestChecked(db: Queryable, req: Request, secret: string, nowSeconds: number): Promise<Actor | null> {
  const p = verifySession(readCookie(req, SESSION_COOKIE), secret, nowSeconds);
  if (!p) return null;
  const res = await db.query(`SELECT id, user_type FROM app_user WHERE id = $1 AND status = 'active' AND user_type = $2`, [p.uid, p.ut]);
  const row = res.rows[0];
  return row && row["id"] === p.uid && row["user_type"] === p.ut ? { userId: p.uid, userType: p.ut } : null;
}

/** Cookie-only, no database check: requests must use actorFromRequestChecked. The signed-in user from the session cookie, or null. Fails closed on a missing, forged or expired session. */
export function actorFromRequest(req: Request, secret: string, nowSeconds: number): Actor | null {
  const p = verifySession(readCookie(req, SESSION_COOKIE), secret, nowSeconds);
  return p ? { userId: p.uid, userType: p.ut } : null;
}
