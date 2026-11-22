import { NextResponse } from "next/server";
import { deleteSavedSearch } from "../../../../../src/domain/saved-search-service";
import { getActor } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { getSavedSearchRepo } from "../../../../../src/server/saved-search-context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ searchId: string }> };

/** Deletes the signed-in buyer's own saved search. */
async function handleDelete(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await deleteSavedSearch(getSavedSearchRepo(), actor.userId, (await params).searchId);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const DELETE = withApi(handleDelete);
