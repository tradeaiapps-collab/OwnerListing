import { getActor, getDb } from "../../../../../../src/server/context";
import { getRepairPhoto } from "../../../../../../src/server/elena-rentals-db";
import { imageHeaders } from "../../../../../../src/server/photo-route";
import { unauthenticated } from "../../../../../../src/server/http";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string; photoId: string }> };

/** A repair photo, for the tenant, the owner, or the contractor once they have accepted the job. Never public, never cached. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id, photoId } = await params;
  const p = await getRepairPhoto(getDb(), actor.userId, id, photoId);
  if (!p) return new Response(JSON.stringify({ error: "Not found." }), { status: 404, headers: { "content-type": "application/json" } });
  return new Response(new Uint8Array(p.bytes), { headers: imageHeaders(p.mime, p.bytes.length, false) });
}

export const GET = withApi(handleGet);
