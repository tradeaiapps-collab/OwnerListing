import { parseJobPrefs } from "../../../../src/domain/contractor-ops";
import { csrfGuard } from "../../../../src/server/csrf";
import { getActor, getDb } from "../../../../src/server/context";
import { getJobPrefs, saveJobPrefs } from "../../../../src/server/contractor-ops-db";
import { error, json } from "../../../../src/server/contractor-ops-route";
import { unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in user's own job alert choices. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return json({ preferences: await getJobPrefs(getDb(), actor.userId) });
}

/** Body: { email, sms, reminderHours: 0 | 2 | 24 | 48 }. Texts also need a verified phone and texts turned on under Notifications. */
async function handlePut(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const parsed = parseJobPrefs(await req.json().catch(() => null));
  if (!parsed.ok) return error(400, parsed.message);
  await saveJobPrefs(getDb(), actor.userId, parsed.value);
  return json({ preferences: parsed.value });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
