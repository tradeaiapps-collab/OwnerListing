import { NextResponse } from "next/server";
import { parseCampaign } from "../../../../src/domain/campaigns";
import { audienceCountPg, createCampaignPg, listCampaignsPg } from "../../../../src/server/campaigns-db";
import { getDb, getDeps } from "../../../../src/server/context";
import { fail, readJsonObject, staffAudit, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

async function handleGet(req: Request) {
  const staff = await staffGate(req, "campaign.manage");
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json({ campaigns: await listCampaignsPg(getDb()) }, { headers: { "cache-control": "no-store" } });
}

/**
 * Create a campaign (name, channel, segment, segmentConfig, subject, body, ctaUrl, optional scheduledAt), or with { action: "preview" } count
 * how many people it would reach now (only people who opted in to marketing on that channel).
 */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "campaign.manage");
  if (staff instanceof NextResponse) return staff;
  const b = await readJsonObject(req);
  if (!b) return fail(400, "Send a JSON body.");
  const p = parseCampaign(b, getDeps().now());
  if (!p.ok) return fail(400, p.error);
  if (b["action"] === "preview") {
    return NextResponse.json({ audience: await audienceCountPg(getDb(), p.value.channel, p.value.segment, p.value.segmentConfig) });
  }
  const id = await createCampaignPg(getDb(), p.value, staff.id);
  await staffAudit(staff, "campaign", id, "staff.campaign_created", { channel: p.value.channel, segment: p.value.segment, scheduled: p.value.scheduledAt !== null });
  return NextResponse.json({ ok: true, id }, { status: 201 });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
