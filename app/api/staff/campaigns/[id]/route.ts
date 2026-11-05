import { NextResponse } from "next/server";
import { parseCampaign } from "../../../../../src/domain/campaigns";
import { audienceCountPg, getCampaignPg, moveCampaignPg, updateCampaignPg } from "../../../../../src/server/campaigns-db";
import { getDb, getDeps } from "../../../../../src/server/context";
import { fail, readJsonObject, staffAudit, staffGate, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

async function handleGet(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "campaign.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Campaign not found.");
  const c = await getCampaignPg(getDb(), id);
  if (!c) return fail(404, "Campaign not found.");
  const audience = c.status === "draft" || c.status === "scheduled" ? await audienceCountPg(getDb(), c.channel, c.segment, c.segmentConfig) : null;
  return NextResponse.json({ campaign: c, audience }, { headers: { "cache-control": "no-store" } });
}

/** Edit a draft or scheduled campaign (same body as create). */
async function handlePatch(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "campaign.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Campaign not found.");
  const b = await readJsonObject(req);
  if (!b) return fail(400, "Send a JSON body.");
  const p = parseCampaign(b, getDeps().now());
  if (!p.ok) return fail(400, p.error);
  if (!(await updateCampaignPg(getDb(), id, p.value))) return fail(409, "Only a draft or scheduled campaign can be edited.");
  await staffAudit(staff, "campaign", id, "staff.campaign_updated", { channel: p.value.channel, segment: p.value.segment });
  return NextResponse.json({ ok: true });
}

/** Body { action: "send" | "schedule" | "unschedule" | "cancel", scheduledAt? }. Send starts at the next tick (within 15 minutes) and fixes the recipient list. */
async function handlePost(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "campaign.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Campaign not found.");
  const b = await readJsonObject(req);
  const action = b?.["action"];
  const to = action === "send" ? "sending" : action === "schedule" ? "scheduled" : action === "unschedule" ? "draft" : action === "cancel" ? "cancelled" : null;
  if (!to) return fail(400, "Choose send, schedule, unschedule or cancel.");
  let at: string | null = null;
  if (to === "scheduled") {
    const t = Date.parse(String(b?.["scheduledAt"] ?? ""));
    if (Number.isNaN(t) || t < Date.parse(getDeps().now()) - 60_000) return fail(400, "Choose a send time in the future.");
    at = new Date(t).toISOString();
  }
  const r = await moveCampaignPg(getDb(), id, to, at);
  if (!r.ok) return fail(r.error === "Campaign not found." ? 404 : 409, r.error);
  await staffAudit(staff, "campaign", id, `staff.campaign_${String(action)}`, { scheduledAt: at });
  return NextResponse.json({ ok: true });
}

export const GET = withApi(handleGet);
export const PATCH = withApi(handlePatch);
export const POST = withApi(handlePost);
