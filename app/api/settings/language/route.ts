import { NextResponse } from "next/server";
import { getLanguage, parsePrefsInput, setLanguage } from "../../../../src/domain/multilingual-service";
import { getActor } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../src/server/http";
import { getMultilingualDeps } from "../../../../src/server/multilingual-db";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in user's chat language: "auto" (detect from what they write) or one language, plus what was last detected. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json(await getLanguage(getMultilingualDeps(), actor.userId));
}

/** Body: { language: "auto" | "zh-Hans" | ... }. Always saved for the signed-in user. */
async function handlePut(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const p = parsePrefsInput(await req.json().catch(() => null));
  if (!p.ok) return failure(p);
  const deps = getMultilingualDeps();
  await setLanguage(deps, actor.userId, p.value.language);
  return NextResponse.json(await getLanguage(deps, actor.userId));
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
