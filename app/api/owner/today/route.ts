import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../src/server/http";
import { getDigest, ownerToday, setDigest } from "../../../../src/server/owner-today-db";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in owner's "what needs you" list, built from live data each time, and whether the daily email is on. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const [items, digest] = await Promise.all([ownerToday(getDb(), actor.userId, new Date().toISOString()), getDigest(getDb(), actor.userId)]);
  return NextResponse.json({ items, digest });
}

/** Body: { "digest": true | false } turns the daily email on or off. */
async function handlePut(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const b = (await req.json().catch(() => null)) as { digest?: unknown } | null;
  if (typeof b?.digest !== "boolean") return failure({ ok: false, code: "invalid", message: "Send digest as true or false." });
  await setDigest(getDb(), actor.userId, b.digest);
  return NextResponse.json({ digest: { enabled: b.digest } });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
