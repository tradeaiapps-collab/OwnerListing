import { NextResponse } from "next/server";
import { parseGenerateInput, parseHolidayInput } from "../../../../src/domain/public-holidays";
import { getDb } from "../../../../src/server/context";
import { generateHolidaysPg, listHolidaysPg, upsertHolidayPg } from "../../../../src/server/public-holidays-db";
import { fail, readJsonObject, staffAudit, staffGate } from "../../../../src/server/staff-route";
import { isHolidayState } from "../../../../src/domain/public-holidays";
import { withApi } from "../../../../src/server/api/with-api";

/** Public holidays for ?year= (default this year), optionally one ?state=. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "holiday.manage");
  if (staff instanceof NextResponse) return staff;
  const q = new URL(req.url).searchParams;
  const year = Number(q.get("year") ?? new Date().getUTCFullYear()), state = q.get("state");
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return fail(400, "The year must be between 2000 and 2100.");
  if (state !== null && !isHolidayState(state)) return fail(400, "Unknown state.");
  return NextResponse.json({ year, holidays: await listHolidaysPg(getDb(), year, state ?? undefined) }, { headers: { "cache-control": "no-store" } });
}

/**
 * Adds or renames one holiday: { state, date, name }. Or, with { action: "generate", state: "NSW" | "ALL", year }, fills in the usual
 * holidays for that year (dates already on file are kept). Logged.
 */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "holiday.manage");
  if (staff instanceof NextResponse) return staff;
  const b = await readJsonObject(req);
  if (b?.["action"] === "generate") {
    const g = parseGenerateInput(b);
    if (!g.ok) return fail(400, g.error);
    const added = await generateHolidaysPg(getDb(), g.value.states, g.value.year, staff.id);
    await staffAudit(staff, "public_holiday", `${g.value.year}`, "staff.public_holidays_generated", { year: g.value.year, states: g.value.states, added });
    return NextResponse.json({ ok: true, added }, { status: 201 });
  }
  const p = parseHolidayInput(b);
  if (!p.ok) return fail(400, p.error);
  const r = await upsertHolidayPg(getDb(), p.value, staff.id);
  await staffAudit(staff, "public_holiday", r.id, r.created ? "staff.public_holiday_added" : "staff.public_holiday_renamed", { ...p.value });
  return NextResponse.json({ ok: true, id: r.id, created: r.created }, { status: r.created ? 201 : 200 });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
