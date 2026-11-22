import { readBrand } from "../config/brand";
import {
  composeContractorMessage, mobileE164, parseEmergencyRequest, parseReply, pickRecipients, requestNumber, requestRateOk, TRADE_LABELS,
  type EmergencyRequestInput
} from "../domain/emergency";
import { renderEmail } from "../domain/email-templates";
import type { Actor, Result } from "../domain/listing-service";
import type { Queryable } from "./db";
import { acceptPg, addContactPg, candidatesPg, cancelPg, createRequestPg, declinePg, listRequestsPg, ownListingPg, recentRequestTimesPg } from "./emergency-db";
import { getEmailPort, getSmsPort } from "./messaging";
import { recipientPg } from "./notifications-db";
import { notifyUser } from "./notifier";

type Env = Readonly<Record<string, string | undefined>>;
export interface UrgentOutcome { number: number; id: string; contacted: number; message: string }

const fail = (code: "invalid" | "not_found" | "rate_limited" | "forbidden" | "conflict", message: string): Result<never> => ({ ok: false, code, message });

/**
 * Elena's urgent request. Checks the requester's rate limit, scans the text, finds contractors who match the trade and area and are
 * available now (their own hours, their own time zone), and sends each one a fixed-template email and, for a mobile number, a text.
 * Every send goes through the logged messaging ports (messaging_outbox). The requester's street address and callback number are not in
 * the message: they go to the one contractor who accepts. Nobody is contacted who did not opt in to emergency jobs.
 */
export async function submitUrgentRequest(db: Queryable, env: Env, actor: Actor, body: unknown, nowIso = new Date().toISOString()): Promise<Result<UrgentOutcome>> {
  const parsed = parseEmergencyRequest(body);
  if (!parsed.ok) return parsed;
  const rate = requestRateOk(await recentRequestTimesPg(db, actor.userId), nowIso);
  if (!rate.ok) return rate;
  let input: EmergencyRequestInput = parsed.value;
  if (input.listingId) {
    const l = await ownListingPg(db, input.listingId, actor.userId);
    if (!l) return fail("not_found", "That property was not found on your account.");
    input = { ...input, addressText: l.addressText, suburb: l.suburb, postcode: l.postcode, propertyKind: l.propertyKind };
    if (!input.suburb && !input.postcode) return fail("invalid", "That property has no suburb or postcode yet. Enter them in the form instead.");
  }
  const created = await createRequestPg(db, actor.userId, input);
  const candidates = pickRecipients({ trade: input.trade, suburb: input.suburb ?? undefined, postcode: input.postcode ?? undefined }, await candidatesPg(db, input.trade), nowIso, actor.userId);
  const brand = readBrand().name;
  const base = (env["APP_URL"] ?? "").replace(/\/+$/, "");
  const link = `${base}/contractor/emergency`;
  const who = (await db.query("SELECT display_name FROM app_user WHERE id = $1::uuid", [actor.userId])).rows[0];
  const facts = { number: created.number, trade: input.trade, description: input.description, suburb: input.suburb, postcode: input.postcode, propertyKind: input.propertyKind, requesterFirstName: String(who?.["display_name"] ?? "A customer").split(" ")[0] || "A customer", brand };
  const msg = composeContractorMessage(facts, link);
  let contacted = 0, delivered = 0;
  for (const c of candidates) {
    let email: "sent" | "failed" | "skipped" = "skipped", sms: "sent" | "failed" | "skipped" = "skipped";
    try {
      const to = (await recipientPg(db, c.userId)).email;
      if (to && base) {
        const mail = renderEmail({ brand, title: msg.subject, body: msg.text, actionUrl: link, actionLabel: "Open the request", reason: "You are receiving this because you opted in to emergency jobs. You can turn this off on your emergency settings page.", settingsUrl: `${base}/contractor/emergency` });
        const port = await getEmailPort(db, env, "emergency_request");
        email = port.configured && (await port.send({ to, ...mail, subject: msg.subject })).status === "sent" ? "sent" : "failed";
      }
      const e164 = mobileE164(c.profile.contactPhone);
      if (e164 && base) {
        const port = await getSmsPort(db, env, "emergency_request");
        sms = port.configured && (await port.sendText(e164, msg.sms)).status === "sent" ? "sent" : "failed";
      }
    } catch { /* a delivery problem for one contractor must not stop the others */ }
    await addContactPg(db, created.id, c.userId, { email, sms });
    contacted++;
    if (email === "sent" || sms === "sent") delivered++;
    await notifyUser(db, c.userId, "emergency_request", { reference: requestNumber(created.number), text: `${facts.requesterFirstName} needs a ${TRADE_LABELS[input.trade].toLowerCase()} in ${input.suburb ?? input.postcode ?? "your area"}. Open it to accept or pass.`, link: "/contractor/emergency" }, env, "in_app");
  }
  const message = contacted > 0
    ? `Elena has asked ${contacted} ${contacted === 1 ? "contractor" : "contractors"} who ${contacted === 1 ? "is" : "are"} available now${delivered < contacted ? " (some will see it in the app because email or text could not be sent)" : ""}. Replies appear on this page.`
    : "No emergency contractor who is available right now covers that area. Search the directory below and call one yourself, or try again later. If anyone is in danger, call 000.";
  return { ok: true, value: { number: created.number, id: created.id, contacted, message } };
}

/** A contractor accepts or declines. Accepting makes the request their numbered job and tells the requester. */
export async function replyToRequest(db: Queryable, env: Env, actor: Actor, requestId: string, body: unknown): Promise<Result<{ status: "accepted" | "declined" }>> {
  const parsed = parseReply(body);
  if (!parsed.ok) return parsed;
  const r = parsed.value;
  if (r.kind === "decline") {
    return (await declinePg(db, requestId, actor.userId, r.note)) ? { ok: true, value: { status: "declined" } } : fail("conflict", "This request is no longer open.");
  }
  const done = await acceptPg(db, requestId, actor.userId, r);
  if (!done) return fail("conflict", "This request is no longer open, or someone else already took it.");
  const name = String((await db.query("SELECT display_name FROM app_user WHERE id = $1::uuid", [actor.userId])).rows[0]?.["display_name"] ?? "A contractor");
  await notifyUser(db, done.requesterId, "emergency_accepted", { name, link: "/emergency", text: `${name} accepted your urgent request ${requestNumber(done.number)}${r.etaMinutes ? ` and expects to arrive in about ${r.etaMinutes} minutes` : ""}. Open it for their contact details. Pay them directly.` }, env);
  return { ok: true, value: { status: "accepted" } };
}

export async function cancelRequest(db: Queryable, actor: Actor, requestId: string): Promise<Result<true>> {
  return (await cancelPg(db, requestId, actor.userId)) ? { ok: true, value: true } : fail("not_found", "That request is not open.");
}
export const listMyRequests = (db: Queryable, actor: Actor) => listRequestsPg(db, actor.userId);
