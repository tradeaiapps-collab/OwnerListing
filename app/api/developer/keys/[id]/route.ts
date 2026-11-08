import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { unauthenticated } from "../../../../../src/server/http";
import { revokeKey } from "../../../../../src/server/public-api-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Revokes one of the signed-in user's keys. Takes effect on the next call, including for tokens already issued from it. */
async function handleDelete(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !(await revokeKey(getDb(), actor.userId, id))) return NextResponse.json({ error: "Key not found." }, { status: 404 });
  return NextResponse.json({ revoked: true });
}

export const DELETE = withApi(handleDelete);
