import { NextResponse } from "next/server";
import { viewIdImage, type ImageKind } from "../../../../../../src/domain/id-review-service";
import { fail } from "../../../../../../src/domain/listing-service";
import { getActor, getIdDeps } from "../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../src/server/http";

export async function GET(req: Request, ctx: { params: Promise<{ id: string; which: string }> }) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const { id, which } = await ctx.params;
  if (which !== "front" && which !== "back" && which !== "selfie") return failure(fail("not_found", "Not found."));
  const r = await viewIdImage(getIdDeps(), actor, id, which as ImageKind);
  if (!r.ok) return failure(r);
  return new NextResponse(Buffer.from(r.value.bytes), {
    headers: {
      "content-type": r.value.contentType,
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox"
    }
  });
}
