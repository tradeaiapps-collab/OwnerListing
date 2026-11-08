import { NextResponse } from "next/server";
import { parseBuyerDetails } from "../../../../src/domain/prequalification";
import { csrfGuard } from "../../../../src/server/csrf";
import { getActor, getDb, getDeps, getUploadPorts } from "../../../../src/server/context";
import { extractText } from "../../../../src/server/doc-extract";
import { failure, unauthenticated } from "../../../../src/server/http";
import { listForBuyer } from "../../../../src/server/prequalification-db";
import { MAX_PREQUAL_BYTES, submitPrequalification } from "../../../../src/server/prequalification-service";
import { withApi } from "../../../../src/server/api/with-api";

const notBuyer = () => failure({ ok: false, code: "forbidden", message: "Pre-approvals are for buyer accounts." });

/** The signed-in buyer's own pre-approvals with their status and Elena's summary. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "buyer") return notBuyer();
  const items = await listForBuyer(getDb(), actor.userId, getDeps().now());
  return NextResponse.json({ items }, { headers: { "cache-control": "private, no-store" } });
}

/**
 * Adds a pre-approval letter (multipart: file as PDF; optional amount, rate, term, conditions, listingId, share). Buyer accounts only.
 * The letter is stored privately; sellers only ever see the verified summary, never the file or the buyer's details.
 */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "buyer") return notBuyer();
  const ports = getUploadPorts();
  if (!ports.storage.configured || !ports.scanner.configured) return NextResponse.json({ error: "Pre-approval upload is not available yet." }, { status: 503 });
  const length = Number(req.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0 || length > MAX_PREQUAL_BYTES + 100_000) {
    return NextResponse.json({ error: "The letter must be a PDF under 10 MB." }, { status: 413 });
  }
  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "Invalid upload." }, { status: 400 }); }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose the pre-approval PDF." }, { status: 400 });
  const field = (k: string) => { const v = form.get(k); return typeof v === "string" ? v : undefined; };
  const details = parseBuyerDetails({ amount: field("amount"), rate: field("rate"), term: field("term"), conditions: field("conditions"), listingId: field("listingId"), share: field("share") });
  if (!details.ok) return NextResponse.json({ error: details.error }, { status: 400 });
  const r = await submitPrequalification(
    { db: getDb(), storage: ports.storage, scanner: ports.scanner, now: () => getDeps().now(), extract: async (b, t) => { const x = await extractText(b, t); return x.ok ? { ok: true, text: x.text } : { ok: false, message: x.message }; } },
    actor.userId, new Uint8Array(await file.arrayBuffer()), file.type, details.value
  );
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
