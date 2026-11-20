import { readBrand } from "../config/brand";
import {
  composeContractorMessage, mobileE164, parseEmergencyRequest, parseReply, pickRecipients, requestNumber, requestRateOk, TRADE_LABELS,
  type EmergencyRequestInput, type RequestFacts
} from "../domain/emergency";
import { formatJobNo } from "../domain/contractor-market";
import { renderEmail } from "../domain/email-templates";
import type { Actor, Result } from "../domain/listing-service";
import type { Queryable } from "./db";
import {
  acceptPg, addContactPg, candidatesPg, cancelPg, contactedPg, createRequestPg, declinePg, dueRequestsPg, linkJobPg, listRequestsPg, markRoundPg, ownListingPg, recentRequestTimesPg, unlinkedAcceptedPg,
  MAX_CONTRACTORS_PER_REQUEST, WIDEN_AFTER_MINUTES
} from "./emergency-db";
import { getEmailPort, getSmsPort } from "./messaging";
import { recipientPg } from "./notifications-db";
import { notifyUser } from "./notifier";

type Env = Readonly<Record<string, string | undefined>>;
export interface UrgentOutcome { number: number; id: string; contacted: number; message: string }

const fail = (code: "invalid" | "not_found" | "rate_limited" | "forbidden" | "conflict", message: string): Result<never> => ({ ok: false, code, message });


async function factsFor(db: Queryable, requesterId: string, number: number, i: Pick<EmergencyRequestInput, "trade" | "description" | "suburb" | "postcode" | "propertyKind">): Promise<RequestFacts> {
  const who = (await db.query("SELECT display_name FROM app_user WHERE id = $1::uuid", [requesterId])).rows[0];
  return { number, trade: i.trade, description: i.description, suburb: i.suburb, postcode: i.postcode, propertyKind: i.propertyKind, requesterFirstName: String(who?.["display_name"] ?? "A customer").split(" ")[0] || "A customer", brand: readBrand().name };
}

/**
 * Sends the fixed-template request to the contractors who match the trade and area, are available now and have not been asked about this
 * request yet (`already`), up to the per-request cap. One send never stops the others. Returns how many were asked and how many were also reached outside the app.
 */
async function askContractors(
  db: Queryable, env: Env, requestId: string, facts: RequestFacts, area: Pick<EmergencyRequestInput, "trade" | "suburb" | "postcode">, requesterId: string,
  already: readonly string[], nowIso: string
): Promise<{ contacted: number; delivered: number }> {
  const room = Math.max(0, MAX_CONTRACTORS_PER_REQUEST - already.length);
  const candidates = pickRecipients({ trade: area.trade, suburb: area.suburb ?? undefined, postcode: area.postcode ?? undefined },
    (await candidatesPg(db, area.trade)).filter(c => !already.includes(c.userId)), nowIso, requesterId).slice(0, room);
  const brand = facts.brand;
  const base = (env["APP_URL"] ?? "").replace(/\/+$/, "");
  const link = `${base}/contractor/emergency`;
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
    await addContactPg(db, requestId, c.userId, { email, sms });
    contacted++;
    if (email === "sent" || sms === "sent") delivered++;
    await notifyUser(db, c.userId, "emergency_request", { reference: requestNumber(facts.number), text: `${facts.requesterFirstName} needs a ${TRADE_LABELS[area.trade].toLowerCase()} in ${area.suburb ?? area.postcode ?? "your area"}. Open it to accept or pass.`, link: "/contractor/emergency" }, env, "in_app");
  }
  return { contacted, delivered };
}

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
  const facts: RequestFacts = await factsFor(db, actor.userId, created.number, input);
  const { contacted, delivered } = await askContractors(db, env, created.id, facts, input, actor.userId, [], nowIso);
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
  const job = await linkJob(db, requestId, done.trade);
  const name = String((await db.query("SELECT display_name FROM app_user WHERE id = $1::uuid", [actor.userId])).rows[0]?.["display_name"] ?? "A contractor");
  const ref = job ? formatJobNo(job.jobNumber) : requestNumber(done.number);
  await notifyUser(db, done.requesterId, "emergency_accepted", { name, link: "/emergency", text: `${name} accepted your urgent request and it is now ${ref}${r.etaMinutes ? `. They expect to arrive in about ${r.etaMinutes} minutes` : ""}. Open it for their contact details. Pay them directly.` }, env);
  return { ok: true, value: { status: "accepted" } };
}

/** Gives the accepted request its JOB- number (and a real job on the requester's own listing). A failure leaves the cron to repair it. */
async function linkJob(db: Queryable, requestId: string, trade: EmergencyRequestInput["trade"]) {
  try { return await linkJobPg(db, requestId, `Emergency ${TRADE_LABELS[trade].toLowerCase()}`); } catch { return undefined; }
}

export interface WidenResult { widened: number; asked: number; linked: number }

/**
 * The cron step. An open request nobody has answered for 15 minutes is offered to the next contractors who are available now and have not been
 * asked yet, up to 3 rounds and 12 contractors; the requester is told. Accepted requests that missed their JOB- number get it. Reuses the
 * same send, limits and logging as the first round; never throws.
 */
export async function runDueEmergency(db: Queryable, env: Env, nowIso: string): Promise<WidenResult> {
  const out: WidenResult = { widened: 0, asked: 0, linked: 0 };
  for (const u of await unlinkedAcceptedPg(db).catch(() => [])) if (await linkJob(db, u.id, u.trade)) out.linked++;
  for (const r of await dueRequestsPg(db, nowIso).catch(() => [])) {
    try {
      const already = await contactedPg(db, r.id);
      if (already.length >= MAX_CONTRACTORS_PER_REQUEST) { await markRoundPg(db, r.id, nowIso, false); continue; }
      const facts: RequestFacts = { number: r.number, trade: r.trade, description: r.description, suburb: r.suburb, postcode: r.postcode, propertyKind: r.propertyKind, requesterFirstName: r.requesterName, brand: readBrand().name };
      const { contacted } = await askContractors(db, env, r.id, facts, r, r.requesterId, already, nowIso);
      await markRoundPg(db, r.id, nowIso, contacted > 0);
      if (contacted > 0) {
        out.widened++; out.asked += contacted;
        await notifyUser(db, r.requesterId, "emergency_update", { title: `Urgent request ${requestNumber(r.number)}: asking more contractors`, text: `Nobody has answered for ${WIDEN_AFTER_MINUTES} minutes, so Elena asked ${contacted} more ${contacted === 1 ? "contractor" : "contractors"} who ${contacted === 1 ? "is" : "are"} available now. You can also call one from the emergency directory.`, link: "/emergency" }, env);
      }
    } catch { /* one request must not stop the rest */ }
  }
  return out;
}

export async function cancelRequest(db: Queryable, actor: Actor, requestId: string): Promise<Result<true>> {
  return (await cancelPg(db, requestId, actor.userId)) ? { ok: true, value: true } : fail("not_found", "That request is not open.");
}
export const listMyRequests = (db: Queryable, actor: Actor) => listRequestsPg(db, actor.userId);
