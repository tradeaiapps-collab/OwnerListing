import { NextResponse } from "next/server";
import { getActor, getDb, getUploadPorts } from "../../../src/server/context";
import { csrfGuard } from "../../../src/server/csrf";
import { createRentalSender, submitRepair } from "../../../src/server/elena-rentals-db";
import { failure, unauthenticated } from "../../../src/server/http";
import { withApi } from "../../../src/server/api/with-api";

const MAX_BODY = 8 * 1024 * 1024;

/**
 * A tenant reports a repair. multipart/form-data: tenancyId, category, description, optional emergency/urgent ("true"), and up to 3 image files named photo.
 * Elena sorts it by urgency, tells the tenant what to do first, and tells the owner. The tenant must have an active tenancy for that home.
 */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  // The size must be declared and within the limit before anything is read, so an unbounded body is never buffered.
  const declared = Number(req.headers.get("content-length"));
  if (!Number.isFinite(declared) || declared <= 0) return NextResponse.json({ error: "Send the repair request as a normal form upload." }, { status: 411 });
  if (declared > MAX_BODY) return NextResponse.json({ error: "That upload is too large." }, { status: 413 });
  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "Invalid upload." }, { status: 400 }); }
  const photos: { bytes: Uint8Array }[] = [];
  for (const f of form.getAll("photo").slice(0, 4)) if (f instanceof File && f.size > 0) photos.push({ bytes: new Uint8Array(await f.arrayBuffer()) });
  const body = Object.fromEntries([...form.entries()].filter(([k, v]) => k !== "photo" && typeof v === "string"));
  const db = getDb();
  const r = await submitRepair(db, createRentalSender(db), process.env, actor.userId, body, photos, new Date().toISOString(), getUploadPorts().scanner);
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
}

export const POST = withApi(handlePost);
