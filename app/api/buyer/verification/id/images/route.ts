import { NextResponse } from "next/server";
import { MAX_ID_REQUEST_BYTES, type IdImagePart } from "../../../../../../src/domain/id-image";
import type { Failure } from "../../../../../../src/domain/listing-service";
import { clientIp } from "../../../../../../src/server/client-ip";
import { getActor } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { submitIdImages, type IdUploadInput } from "../../../../../../src/server/id-image";
import { getIdImageDeps } from "../../../../../../src/server/verification-context";
import { withApi } from "../../../../../../src/server/api/with-api";

const FIELDS = ["consent", "consentVersion", "documentKind", "documentCountry", "expiryDate", "selfieSource"] as const;
const PARTS: readonly IdImagePart[] = ["front", "back", "selfie"];

/** Reads the multipart body only after the pre-checks pass; the size is capped from Content-Length first. */
async function readUpload(req: Request): Promise<IdUploadInput | Failure> {
  const length = Number(req.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0 || length > MAX_ID_REQUEST_BYTES) return { ok: false, code: "invalid", message: "The photos are missing or too large." };
  let form: FormData;
  try { form = await req.formData(); } catch { return { ok: false, code: "invalid", message: "Invalid upload." }; }
  const fields: Record<string, string | undefined> = {};
  for (const k of FIELDS) { const v = form.get(k); if (typeof v === "string") fields[k] = v; }
  const files: Partial<Record<IdImagePart, Uint8Array>> = {};
  for (const p of PARTS) { const f = form.get(p); if (f instanceof File && f.size > 0) files[p] = new Uint8Array(await f.arrayBuffer()); }
  return { fields, files };
}

/** Status of the buyer's latest ID photo submission (pending, approved, rejected, needs_more or null). Never any image or detail. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "buyer") return NextResponse.json({ error: "Buyers only." }, { status: 403 });
  try {
    return NextResponse.json({ status: await getIdImageDeps().store.latestStatus(actor.userId) }, { headers: { "cache-control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load." }, { status: 503 });
  }
}

/**
 * Buyer uploads photos of an Australian government photo ID (front, and back unless passport) and a live selfie
 * (multipart). Buyers only. Configuration, rate limits and buyer state are checked before the body is read.
 * Upload only: no route gives the images back to the buyer.
 */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "buyer") return NextResponse.json({ error: "Buyers only." }, { status: 403 });
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "multipart/form-data") return NextResponse.json({ error: "Send the photos as a form upload." }, { status: 415 });
  try {
    const r = await submitIdImages(getIdImageDeps(), actor.userId, clientIp(req), () => readUpload(req));
    return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
  } catch {
    return NextResponse.json({ error: "ID photo upload is unavailable right now. Try again later." }, { status: 503 });
  }
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
