import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { fetchMetaLead } from "../../../../../src/adapters/ad-lead-providers";
import { LEAD_LIMITS, parseMetaWebhook, verifyMetaSignature } from "../../../../../src/domain/ad-leads";
import { getDb } from "../../../../../src/server/context";
import { ingestLead, sourceForMetaPage } from "../../../../../src/server/ad-lead-db";
import { loadMetaConfig } from "../../../../../src/server/meta-lead-settings-db";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Meta (Facebook/Instagram) Lead Ads webhook. FAILS CLOSED: 503 until the app secret, verify token and Page access token are set (admin screen /staff/meta-leads, or META_* environment variables which win).
 * GET answers Meta's one-off subscription check (hub.verify_token). POST must carry a valid X-Hub-Signature-256 over the raw body.
 * Meta sends only a lead id; the answers are fetched with the Page token. A failed fetch answers 502 so Meta retries (ingest is idempotent).
 */
async function handleGet(req: Request) {
  const cfg = await loadMetaConfig(getDb(), process.env);
  if (!cfg) return NextResponse.json({ error: "Meta lead ads are not set up." }, { status: 503 });
  const q = new URL(req.url).searchParams;
  const token = q.get("hub.verify_token") ?? "";
  const d = (v: string) => createHash("sha256").update(v).digest();
  const same = timingSafeEqual(d(token), d(cfg.verifyToken));
  if (q.get("hub.mode") !== "subscribe" || !same) return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  return new NextResponse((q.get("hub.challenge") ?? "").slice(0, 200), { status: 200, headers: { "content-type": "text/plain" } });
}

async function handlePost(req: Request) {
  const cfg = await loadMetaConfig(getDb(), process.env);
  if (!cfg) return NextResponse.json({ error: "Meta lead ads are not set up." }, { status: 503 });
  if (Number(req.headers.get("content-length") ?? "0") > LEAD_LIMITS.maxWebhookBytes) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const raw = await req.text();
  if (raw.length > LEAD_LIMITS.maxWebhookBytes) return NextResponse.json({ error: "Too large." }, { status: 413 });
  if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"), cfg.appSecret)) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Bad request." }, { status: 400 }); }
  const db = getDb();
  const now = new Date().toISOString();
  let created = 0, skipped = 0, failed = 0;
  for (const ref of parseMetaWebhook(body)) {
    const source = await sourceForMetaPage(db, ref.pageId);
    if (!source) { skipped++; continue; } // a Page we are not connected to (or a paused source): acknowledged, not stored
    const got = await fetchMetaLead(fetch, ref, cfg);
    if ("error" in got) { failed++; continue; }
    const r = await ingestLead(db, source, got.lead, now, process.env);
    if (r.created) created++;
  }
  return NextResponse.json({ created, skipped, failed }, { status: failed > 0 ? 502 : 200 });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
