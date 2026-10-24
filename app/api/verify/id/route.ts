import { NextResponse } from "next/server";
import { myIdStatus, submitId, type SubmitInput } from "../../../../src/domain/id-review-service";
import type { IdDocumentKind } from "../../../../src/domain/id-verification";
import { fail } from "../../../../src/domain/listing-service";
import { getActor, getIdDeps } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";

const MAX_BODY = 16 * 1024 * 1024;

export async function GET(req: Request) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json(await myIdStatus(getIdDeps(), actor));
}

async function bytesOf(v: FormDataEntryValue | null): Promise<Uint8Array | undefined> {
  return v instanceof File && v.size > 0 ? new Uint8Array(await v.arrayBuffer()) : undefined;
}

export async function POST(req: Request) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const len = Number(req.headers.get("content-length") ?? "0");
  if (!Number.isFinite(len) || len <= 0 || len > MAX_BODY) return failure(fail("invalid", "Each image must be a JPEG or PNG under 5 MB."));
  const form = await req.formData().catch(() => null);
  if (!form) return failure(fail("invalid", "Invalid form."));
  const front = await bytesOf(form.get("front"));
  const back = await bytesOf(form.get("back"));
  const selfie = await bytesOf(form.get("selfie"));
  const input: SubmitInput = {
    documentKind: String(form.get("documentKind") ?? "") as IdDocumentKind,
    documentCountry: String(form.get("documentCountry") ?? ""),
    expiryDate: String(form.get("expiryDate") ?? ""),
    selfieCapturedInApp: form.get("selfieCapturedInApp") === "true",
    ...(front ? { front } : {}), ...(back ? { back } : {}), ...(selfie ? { selfie } : {})
  };
  const r = await submitId(getIdDeps(), actor, input);
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
}
