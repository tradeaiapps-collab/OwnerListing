import { NextResponse } from "next/server";
import { isPortal } from "../../../../../src/domain/syndication";
import { getDb } from "../../../../../src/server/context";
import { handleBookingWebhook, MAX_WEBHOOK_BYTES, syndicationDeps } from "../../../../../src/server/syndication-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ portal: string }> };

/** Bookings from a portal. Signed with the portal's webhook secret in x-signature (t=<unix>,v1=<hmac-sha256 of "<t>.<body>">). */
async function handlePost(req: Request, { params }: Ctx) {
  const { portal } = await params;
  if (!isPortal(portal)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_WEBHOOK_BYTES) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const raw = await req.text();
  if (raw.length > MAX_WEBHOOK_BYTES) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const r = await handleBookingWebhook(getDb(), syndicationDeps(), portal, raw, req.headers.get("x-signature"));
  return NextResponse.json(r.body, { status: r.status });
}

export const POST = withApi(handlePost);
