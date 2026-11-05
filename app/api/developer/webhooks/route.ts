import { NextResponse } from "next/server";
import { newWebhookSecret, parseEvents, validateWebhookUrl, WEBHOOK_EVENTS } from "../../../../src/domain/webhooks";
import { withPrincipal } from "../../../../src/server/api/principal";
import { getDb } from "../../../../src/server/context";
import { createEndpoint, listEndpoints } from "../../../../src/server/public-api-db";
import { withApi } from "../../../../src/server/api/with-api";

async function handleGet(req: Request) {
  return withPrincipal(req, "webhooks.manage", async userId => NextResponse.json({ endpoints: await listEndpoints(getDb(), userId), events: WEBHOOK_EVENTS }));
}

/** Creates an endpoint. The signing secret is in this response only. */
async function handlePost(req: Request) {
  return withPrincipal(req, "webhooks.manage", async userId => {
    const body = (await req.json().catch(() => null)) as { url?: unknown; events?: unknown } | null;
    const url = validateWebhookUrl(body?.url);
    if (!url.ok) return NextResponse.json({ error: url.message, code: "invalid_input" }, { status: 400 });
    const events = parseEvents(body?.events);
    if (!events) return NextResponse.json({ error: `Choose one or more events: ${WEBHOOK_EVENTS.join(", ")}.`, code: "invalid_input" }, { status: 400 });
    const secret = newWebhookSecret();
    const row = await createEndpoint(getDb(), userId, url.url, events, secret);
    if (row === "limit") return NextResponse.json({ error: "You have reached the limit of webhook endpoints.", code: "unprocessable" }, { status: 422 });
    return NextResponse.json({ ...row, secret }, { status: 201, headers: { "cache-control": "no-store" } });
  });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
