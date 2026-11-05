import { NextResponse } from "next/server";
import { isKind, parseTemplateInput } from "../../../../src/domain/elena-scheduling";
import { getDb } from "../../../../src/server/context";
import { builtInTemplates, listTemplatesPg, resetTemplatePg, saveTemplatePg } from "../../../../src/server/elena-scheduling-db";
import { fail, readJsonObject, staffAudit, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** Platform-wide wording and the built-in text to start from. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "scheduling_template.manage");
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json({ templates: await listTemplatesPg(getDb(), null), builtIn: builtInTemplates() }, { headers: { "cache-control": "no-store" } });
}

/** Body: { kind, voice, body }. Sets the platform-wide template for one message. Logged. */
async function handlePut(req: Request) {
  const staff = await staffGate(req, "scheduling_template.manage");
  if (staff instanceof NextResponse) return staff;
  const p = parseTemplateInput(await readJsonObject(req));
  if (!p.ok) return fail(400, p.error);
  await saveTemplatePg(getDb(), null, p.value, staff.id);
  await staffAudit(staff, "elena_message_template", p.value.kind, "staff.scheduling_template_saved", { kind: p.value.kind, voice: p.value.voice, length: p.value.body.length });
  return NextResponse.json({ ok: true });
}

/** ?kind= goes back to the built-in wording. Logged. */
async function handleDelete(req: Request) {
  const staff = await staffGate(req, "scheduling_template.manage");
  if (staff instanceof NextResponse) return staff;
  const kind = new URL(req.url).searchParams.get("kind");
  if (!isKind(kind)) return fail(400, "Choose which message to reset.");
  const removed = await resetTemplatePg(getDb(), null, kind);
  if (removed) await staffAudit(staff, "elena_message_template", kind, "staff.scheduling_template_reset", { kind });
  return NextResponse.json({ ok: true });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
export const DELETE = withApi(handleDelete);
