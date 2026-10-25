import { NextResponse } from "next/server";
import { isPersonaId, PERSONAS } from "../../../../../src/domain/assistant-persona";
import { staffCan } from "../../../../../src/domain/staff-access";
import { getDb } from "../../../../../src/server/context";
import { choosePersona, loadPersonaView } from "../../../../../src/server/assistant-persona-db";
import { NO_STORE, readBoundedJson } from "../../../../../src/server/site-route";
import { fail, staffGate, staffGateAny } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * The assistant's character. Anyone who can work on the guide sees the choice; changing it goes live at once, so it needs
 * site.content.publish (built-in: super admin only; a custom role can be given it).
 */
const CHANGE = "site.content.publish";

async function handleGet(req: Request) {
  const staff = await staffGateAny(req, ["site.content.edit", CHANGE]);
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json({ ...(await loadPersonaView(getDb())), personas: PERSONAS, canChange: staffCan(staff, CHANGE) }, { headers: NO_STORE });
}

/** Body: { persona: "elena" | "maya" | "amara" | "sofia" | "noor" }. */
async function handlePut(req: Request) {
  const staff = await staffGate(req, CHANGE);
  if (staff instanceof NextResponse) return staff;
  const body = await readBoundedJson(req, 1024);
  if (body instanceof NextResponse) return body;
  const persona = body["persona"];
  if (!isPersonaId(persona)) return fail(400, "Choose one of the five assistants.");
  const db = getDb();
  await choosePersona(db, staff, persona);
  return NextResponse.json({ ...(await loadPersonaView(db)), personas: PERSONAS, canChange: true }, { headers: NO_STORE });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
