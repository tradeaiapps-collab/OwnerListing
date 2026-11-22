import { NextResponse } from "next/server";
import { parseCertificateFields } from "../../../../src/domain/contractor-certificates";
import { todayUtc } from "../../../../src/domain/contractor-trust";
import { listCertificatesPg } from "../../../../src/server/contractor-certificates-db";
import { uploadCertificate } from "../../../../src/server/contractor-certificate-service";
import { err, sessionActor } from "../../../../src/server/contractor-trust-route";
import { getDb, getDeps, getUploadPorts } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { MAX_CERT_BYTES } from "../../../../src/domain/contractor-certificates";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in contractor's current certificate files (no storage keys): one per kind. */
async function handleGet(req: Request) {
  const actor = await sessionActor(req, { contractor: true });
  if (actor instanceof NextResponse) return actor;
  return NextResponse.json({ certificates: await listCertificatesPg(getDb(), actor.userId) }, { headers: { "cache-control": "private, no-store" } });
}

/** Multipart: file (PDF or photo), kind ("insurance" | "licence"), expiry (YYYY-MM-DD, as printed on the certificate). A newer upload replaces the current one of that kind. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await sessionActor(req, { contractor: true });
  if (actor instanceof NextResponse) return actor;
  const ports = getUploadPorts();
  if (!ports.storage.configured || !ports.scanner.configured) return err(503, "Certificate upload is not available yet.");
  const length = Number(req.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0 || length > MAX_CERT_BYTES + 100_000) return err(413, "The file must be under 10 MB.");
  let form: FormData;
  try { form = await req.formData(); } catch { return err(400, "Invalid upload."); }
  const file = form.get("file");
  if (!(file instanceof File)) return err(400, "Choose the certificate file.");
  const fields = parseCertificateFields(form.get("kind"), form.get("expiry"), todayUtc());
  if (!fields.ok) return err(400, fields.message);
  const r = await uploadCertificate({ db: getDb(), storage: ports.storage, scanner: ports.scanner, now: () => getDeps().now() }, actor.userId, fields.value.kind, fields.value.expiry, new Uint8Array(await file.arrayBuffer()), file.type);
  if (r.ok) return NextResponse.json(r.value, { status: 201 });
  return err(r.code === "unavailable" ? 503 : r.code === "rate_limited" ? 429 : r.code === "forbidden" ? 403 : 400, r.message);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
