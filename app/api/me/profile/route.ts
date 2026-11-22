import { NextResponse } from "next/server";
import { parseDisplayName } from "../../../../src/domain/profile";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in user's own name, email and how they sign in. Never returns the password hash or Google id. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await getDb().query(
    `SELECT display_name, email, (password_hash IS NOT NULL) AS has_password, (google_sub IS NOT NULL) AS has_google
       FROM app_user WHERE id = $1 AND deleted_at IS NULL`,
    [actor.userId]
  );
  const row = r.rows[0];
  if (!row) return unauthenticated();
  return NextResponse.json({ displayName: row["display_name"], email: row["email"] ?? null, hasPassword: row["has_password"] === true, hasGoogle: row["has_google"] === true });
}

/** Body: { displayName }. Changes only the caller's own name; no user id is accepted from the client. */
async function handlePut(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const parsed = parseDisplayName(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  await getDb().query("UPDATE app_user SET display_name = $2 WHERE id = $1 AND deleted_at IS NULL", [actor.userId, parsed.value]);
  return NextResponse.json({ displayName: parsed.value });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
