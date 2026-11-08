import { NextResponse } from "next/server";
import { TOKEN_RE } from "../../../../../src/domain/campaigns";
import { recordClickPg } from "../../../../../src/server/campaigns-db";
import { getDb } from "../../../../../src/server/context";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Tracked link in campaign emails and texts. Redirects to the link staff stored on the campaign (https or a site path), never to anything
 * taken from the request, so it cannot be used as an open redirect. An unknown token goes to the home page.
 */
async function handleGet(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const target = TOKEN_RE.test(token) ? await recordClickPg(getDb(), token).catch(() => null) : null;
  return NextResponse.redirect(new URL(target ?? "/", target?.startsWith("https://") ? undefined : req.url), 302);
}

export const GET = withApi(handleGet);
