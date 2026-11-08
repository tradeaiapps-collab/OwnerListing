import { NextResponse } from "next/server";
import { FEED_LIMITS } from "../../../../../src/domain/property-feed";
import { getDb } from "../../../../../src/server/context";
import { connectionForPush, importPushedReaxml } from "../../../../../src/server/property-feed-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** The body as text, or null once it passes `max` bytes (a chunked upload has no content-length to check first). */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * An agency CRM pushes its REAXML document here: POST /api/feeds/reaxml/{connectionId}, header "authorization: Bearer <push token>",
 * body the XML (up to 20 MB). Machine-to-machine, so no cookie and no CSRF check; the token is the only credential.
 * Wrong id, wrong token and a paused connection all answer the same 401.
 */
async function handlePost(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const db = getDb();
  const conn = await connectionForPush(db, id, token);
  if (!conn) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  if (Number(req.headers.get("content-length") ?? "0") > FEED_LIMITS.maxFeedBytes) return NextResponse.json({ error: "The feed is larger than 20 MB." }, { status: 413 });
  const xml = await readCapped(req, FEED_LIMITS.maxFeedBytes);
  if (xml === null) return NextResponse.json({ error: "The feed is larger than 20 MB." }, { status: 413 });
  const run = await importPushedReaxml(db, conn, xml, new Date().toISOString());
  const counts = { fetched: run.fetched, created: run.created, updated: run.updated, unchanged: run.unchanged, skipped: run.skipped, rejected: run.rejected };
  return run.status === "ok" ? NextResponse.json({ ok: true, ...counts }) : NextResponse.json({ error: run.error, ...counts }, { status: 422 });
}

export const POST = withApi(handlePost);
