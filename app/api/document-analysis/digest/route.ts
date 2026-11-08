import { NextResponse } from "next/server";
import { buildEmailDigest, MAX_DIGEST_EMAILS } from "../../../../src/domain/doc-analyst";
import { csrfGuard } from "../../../../src/server/csrf";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

const MAX_EMAIL_CHARS = 20_000;
const MAX_TOTAL_CHARS = 400_000;

/** Body: { emails: [text, ...] } pasted by the user. Nothing is stored: the digest is computed and returned. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const body: unknown = await req.json().catch(() => null);
  const emails = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["emails"] : undefined;
  if (!Array.isArray(emails) || emails.length === 0 || emails.length > MAX_DIGEST_EMAILS || !emails.every((e): e is string => typeof e === "string" && e.trim() !== "" && e.length <= MAX_EMAIL_CHARS)) {
    return failure({ ok: false, code: "invalid", message: `Send 1 to ${MAX_DIGEST_EMAILS} emails as text, each under ${MAX_EMAIL_CHARS} characters.` });
  }
  if (emails.reduce((n, e) => n + e.length, 0) > MAX_TOTAL_CHARS) return failure({ ok: false, code: "invalid", message: "That is too much text at once." });
  return NextResponse.json(buildEmailDigest(emails.map((text, i) => ({ id: String(i + 1), text }))), { headers: { "cache-control": "private, no-store" } });
}

export const POST = withApi(handlePost);
