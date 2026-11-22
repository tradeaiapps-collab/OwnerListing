import { overlaps } from "../../../../src/domain/contractor-ops";
import { getActor, getDb } from "../../../../src/server/context";
import { contractorCalendar } from "../../../../src/server/contractor-ops-db";
import { json } from "../../../../src/server/contractor-ops-route";
import { unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * The signed-in contractor's own jobs that have a time, soonest first. Each item says which other jobs it overlaps, so the page can warn.
 * Waiting jobs show the listing title only; the address appears once the job is accepted.
 */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const items = await contractorCalendar(getDb(), actor.userId);
  return json({
    items: items.map(a => ({ ...a, clashesWith: items.filter(b => b.assignmentId !== a.assignmentId && overlaps(a, b)).map(b => b.assignmentId) }))
  });
}

export const GET = withApi(handleGet);
