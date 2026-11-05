import { getDb } from "../../../../../src/server/context";
import { icalForToken, syndicationDeps } from "../../../../../src/server/syndication-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ token: string }> };

/** Booked dates of one listing as iCal, for a portal to import. The unguessable token is the credential; the feed holds no guest details. */
async function handleGet(_req: Request, { params }: Ctx) {
  const { token } = await params;
  const ics = await icalForToken(getDb(), token, syndicationDeps().now());
  if (ics === null) return new Response("Not found.", { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(ics, { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" } });
}

export const GET = withApi(handleGet);
