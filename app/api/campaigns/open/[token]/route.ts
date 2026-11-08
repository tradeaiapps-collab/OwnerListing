import { PIXEL_GIF, TOKEN_RE } from "../../../../../src/domain/campaigns";
import { recordOpenPg } from "../../../../../src/server/campaigns-db";
import { getDb } from "../../../../../src/server/context";
import { withApi } from "../../../../../src/server/api/with-api";

/** Open pixel in campaign emails. Always answers with the same 1x1 image, whether or not the token exists. */
async function handleGet(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (TOKEN_RE.test(token)) await recordOpenPg(getDb(), token).catch(() => undefined);
  return new Response(new Uint8Array(PIXEL_GIF), { headers: { "content-type": "image/gif", "cache-control": "no-store, max-age=0" } });
}

export const GET = withApi(handleGet);
