import { NextResponse } from "next/server";
import { viewDocument } from "../../../../../../src/domain/signing-service";
import { getActor, getUploadPorts } from "../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { getSigningRepo, signingIds } from "../../../../../../src/server/signing-db";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string; kind: string }> };

/**
 * Download of the signed PDF or the certificate of completion. Only the owner and the signers of that document (the same check as
 * reading it) can download; everyone else gets 404. Served as an attachment with a generic filename, never cached.
 */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id, kind } = await params;
  if (kind !== "signed_pdf" && kind !== "certificate") return NextResponse.json({ error: "Not found." }, { status: 404 });
  const repo = getSigningRepo();
  const seen = await viewDocument({ ...repo, appendEvent: async () => undefined }, actor, id, signingIds);
  if (!seen.ok) return failure(seen);
  const key = await repo.artifactKey(id, kind);
  const storage = getUploadPorts().storage;
  if (!key || !storage.configured) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const bytes = await storage.get(key).catch(() => null);
  if (!bytes) return NextResponse.json({ error: "The file could not be read right now." }, { status: 503 });
  return new NextResponse(Buffer.from(bytes), {
    headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${kind === "signed_pdf" ? "signed-document" : "certificate-of-completion"}.pdf"`, "x-content-type-options": "nosniff", "cache-control": "no-store" }
  });
}

export const GET = withApi(handleGet);
