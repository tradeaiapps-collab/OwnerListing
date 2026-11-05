import { NextResponse } from "next/server";
import { answerApiQuestion } from "../../../../src/domain/api-insights";
import { withPrincipal } from "../../../../src/server/api/principal";
import { withApi } from "../../../../src/server/api/with-api";

/** Elena answers questions about the API from its OpenAPI description. Rule based and self-hosted: nothing is sent to an outside AI. */
async function handlePost(req: Request) {
  return withPrincipal(req, "listings.read", async () => {
    const body = (await req.json().catch(() => null)) as { question?: unknown } | null;
    const q = typeof body?.question === "string" ? body.question.trim() : "";
    if (q.length < 2 || q.length > 500) return NextResponse.json({ error: "Ask a question of 2 to 500 characters.", code: "invalid_input" }, { status: 400 });
    return NextResponse.json(answerApiQuestion(q));
  });
}

export const POST = withApi(handlePost);
