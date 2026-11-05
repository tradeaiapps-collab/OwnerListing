import { NextResponse } from "next/server";
import { API_SCOPES, API_USER_TYPES, generateKey, parseScopes } from "../../../../src/domain/api-keys";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { unauthenticated } from "../../../../src/server/http";
import { createKey, listKeys } from "../../../../src/server/public-api-db";
import { withApi } from "../../../../src/server/api/with-api";

/** Keys are managed from the signed-in dashboard only (a key cannot create or list keys). Owners and agents. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (!API_USER_TYPES.includes(actor.userType)) return NextResponse.json({ error: "API access is for owners and agents." }, { status: 403 });
  return NextResponse.json({ keys: await listKeys(getDb(), actor.userId), scopes: API_SCOPES });
}

/** Creates a key. The full key is in this response only; afterwards only its public id is shown. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (!API_USER_TYPES.includes(actor.userType)) return NextResponse.json({ error: "API access is for owners and agents." }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { name?: unknown; scopes?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const scopes = parseScopes(body?.scopes);
  if (name.length < 1 || name.length > 80) return NextResponse.json({ error: "Give the key a name of 1 to 80 characters." }, { status: 400 });
  if (!scopes) return NextResponse.json({ error: `Choose one or more scopes: ${API_SCOPES.join(", ")}.` }, { status: 400 });
  const key = generateKey();
  const row = await createKey(getDb(), actor.userId, name, scopes, key);
  if (row === "limit") return NextResponse.json({ error: "You have reached the limit of active keys. Revoke one first." }, { status: 422 });
  return NextResponse.json({ key: row, secretKey: key.fullKey, note: "Copy the key now. It cannot be shown again." }, { status: 201, headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
