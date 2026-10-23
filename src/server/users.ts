import type { Queryable } from "./db";
import type { GoogleIdentity } from "./auth/google";

export interface SignedInUser { id: string; userType: "owner" | "agent" }

/**
 * Finds or creates the user for a verified Google identity, keyed on the Google subject id (not email).
 * Returns null for suspended or closed accounts and for staff or other user types, which cannot use this login yet.
 * A different account already holding the same email makes the insert fail; the caller treats that as a failed login.
 */
export async function upsertGoogleUser(db: Queryable, who: GoogleIdentity): Promise<SignedInUser | null> {
  const res = await db.query(
    `INSERT INTO app_user (email, display_name, user_type, status, google_sub)
     VALUES ($1, $2, 'owner', 'active', $3)
     ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, user_type, status`,
    [who.email, who.name, who.sub]
  );
  const row = res.rows[0];
  if (!row || row["status"] !== "active") return null;
  const type = row["user_type"];
  if ((type !== "owner" && type !== "agent") || typeof row["id"] !== "string") return null;
  // Google only returns verified emails here, so the email step of buyer verification is done.
  await db.query(
    `INSERT INTO buyer_verification (user_id, email_verified_at) VALUES ($1, now())
     ON CONFLICT (user_id) DO UPDATE SET email_verified_at = COALESCE(buyer_verification.email_verified_at, now())`,
    [row["id"]]
  );
  return { id: row["id"], userType: type };
}
