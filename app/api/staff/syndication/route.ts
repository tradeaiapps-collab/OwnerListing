import { NextResponse } from "next/server";
import { isPortal, parsePortalConfig } from "../../../../src/domain/syndication";
import { getDb } from "../../../../src/server/context";
import { fail, readJsonObject, staffGate } from "../../../../src/server/staff-route";
import { overview, savePortal, syndicationDeps } from "../../../../src/server/syndication-db";
import { withApi } from "../../../../src/server/api/with-api";

/** Listing portal setup (syndication.manage, a sensitive permission). Keys and secrets are never returned: only whether they are set. */
const PERMISSION = "syndication.manage";

async function handleGet(req: Request) {
  const staff = await staffGate(req, PERMISSION);
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json(await overview(getDb()), { headers: { "cache-control": "no-store" } });
}

/**
 * Body: { portal, enabled?, mode?, baseUrl?, allowedTransactionTypes?, maxPerMinute?, apiKey? ("" clears), generateWebhookSecret? }.
 * A newly generated webhook secret is in this response only (newWebhookSecret); copy it into the portal's webhook settings.
 */
async function handlePut(req: Request) {
  const staff = await staffGate(req, PERMISSION);
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  if (!body || !isPortal(body["portal"])) return fail(400, "Choose a portal.");
  const config = parsePortalConfig(body);
  if (!config.ok) return fail(400, config.error);
  const apiKey = body["apiKey"];
  if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length > 500 || /\s/.test(apiKey))) return fail(400, "The API key must be one piece of text of at most 500 characters.");
  if (body["generateWebhookSecret"] !== undefined && typeof body["generateWebhookSecret"] !== "boolean") return fail(400, "generateWebhookSecret must be true or false.");
  const r = await savePortal(getDb(), staff, body["portal"], config.value,
    { ...(apiKey !== undefined ? { apiKey: apiKey as string } : {}), generateWebhookSecret: body["generateWebhookSecret"] === true }, syndicationDeps());
  if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.code === "key_not_configured" ? 503 : r.code === "not_found" ? 404 : 409 });
  return NextResponse.json({ portal: r.portal, ...(r.newWebhookSecret ? { newWebhookSecret: r.newWebhookSecret } : {}) }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
