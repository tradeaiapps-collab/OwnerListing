import { NextResponse } from "next/server";
import { MESSAGING_TEST_RATE, isAuMobile } from "../../../../../src/domain/messaging-settings";
import { withinLimit, windowStart } from "../../../../../src/domain/rate-limit";
import { getDb } from "../../../../../src/server/context";
import { sendTestMessage } from "../../../../../src/server/messaging";
import { countHitPg } from "../../../../../src/server/offer-flow-db";
import { fail, readJsonObject, staffAudit, staffGate } from "../../../../../src/server/staff-route";

/**
 * Sends one test message. Body: { channel: "email" } (goes to the signed-in admin's own address) or { channel: "sms", phone: "+61..." }.
 * Limited to a few per hour per admin and overall (both counters fail closed); SMS only to Australian mobiles; a refused attempt still counts. Not configured = nothing sent (409).
 */
export async function POST(req: Request) {
  const staff = await staffGate(req, "staff.manage");
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  const channel = body?.["channel"];
  if (channel !== "sms" && channel !== "email") return fail(400, "Choose sms or email.");
  const phone = body?.["phone"];
  if (channel === "sms" && !isAuMobile(phone)) return fail(400, "Enter an Australian mobile number in international format, for example +61400000000.");
  const hits = await countHitPg(getDb(), `msg-test:${staff.id}`, windowStart(new Date().toISOString(), MESSAGING_TEST_RATE.windowMs));
  const all = await countHitPg(getDb(), "msg-test:all", windowStart(new Date().toISOString(), MESSAGING_TEST_RATE.windowMs));
  if (!withinLimit(hits, MESSAGING_TEST_RATE.perStaff) || !withinLimit(all, MESSAGING_TEST_RATE.allStaff)) return fail(429, "Too many test messages. Try again later.");
  const r = await sendTestMessage(getDb(), process.env, staff.id, channel, channel === "sms" ? (phone as string) : undefined);
  await staffAudit(staff, "messaging_settings", channel, "messaging.test_sent", { channel, outcome: r.status, ...(r.status === "failed" ? { errorCode: r.errorCode } : {}) });
  if (r.status === "not_configured") return NextResponse.json({ outcome: "not_configured", error: `${channel === "sms" ? "SMS" : "Email"} is not configured. Nothing was sent.` }, { status: 409 });
  if (r.status === "failed") return NextResponse.json({ outcome: "failed", errorCode: r.errorCode, error: "The test message could not be sent." }, { status: 502 });
  return NextResponse.json({ outcome: "sent" });
}
