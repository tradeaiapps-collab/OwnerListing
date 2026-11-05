import { NextResponse } from "next/server";
import { isKind, parseTemplateInput } from "../../../../src/domain/elena-scheduling";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { builtInTemplates, isApprovedInspector, listTemplatesPg, resetTemplatePg, saveTemplatePg } from "../../../../src/server/elena-scheduling-db";
import { failure, unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

const noInspector = () => failure({ ok: false, code: "forbidden", message: "Only approved inspectors have message templates." });

/** The inspector's own wording, the platform wording, and the built-in text to start from. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (!(await isApprovedInspector(getDb(), actor.userId))) return noInspector();
  const [own, platform] = await Promise.all([listTemplatesPg(getDb(), actor.userId), listTemplatesPg(getDb(), null)]);
  return NextResponse.json({ own, platform, builtIn: builtInTemplates() }, { headers: { "cache-control": "no-store" } });
}

/** Body: { kind, voice, body }. Saves the inspector's own template for that message. */
async function handlePut(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (!(await isApprovedInspector(getDb(), actor.userId))) return noInspector();
  const p = parseTemplateInput(await req.json().catch(() => null));
  if (!p.ok) return failure({ ok: false, code: "invalid", message: p.error });
  await saveTemplatePg(getDb(), actor.userId, p.value, actor.userId);
  return NextResponse.json({ ok: true });
}

/** ?kind= removes the inspector's own template so the platform wording applies again. */
async function handleDelete(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const kind = new URL(req.url).searchParams.get("kind");
  if (!isKind(kind)) return failure({ ok: false, code: "invalid", message: "Choose which message to reset." });
  await resetTemplatePg(getDb(), actor.userId, kind);
  return NextResponse.json({ ok: true });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
export const DELETE = withApi(handleDelete);
