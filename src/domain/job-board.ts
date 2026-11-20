import type { AuditEvent } from "./audit";
import { respondToAssignment, inviteContractor, type AssignmentIds, type AssignmentRepository } from "./assignment-service";
import { formatJobNo, formatPrice, isTrade, parseContractorNumber, parseReview, rankContractors, type ContractorStats, type MarketCard, type PriceType, type Ranked, type Trade } from "./contractor-market";
import type { AssignmentStatus, JobAssignment } from "./job-chat";
import type { Actor, Failure, Result } from "./listing-service";
import type { Kind } from "./notifications";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound: Failure = { ok: false, code: "not_found", message: "Not found." };
const bad = (message: string): Failure => ({ ok: false, code: "invalid", message });

export interface JobDetail extends JobAssignment {
  jobNumber: number; listingTitle: string; address: string; suburb?: string;
  ownerName: string; contractorName: string; contractorNo?: number; createdAt: string;
  proposedTime?: string; scheduledTime?: string; declineReason?: string; contractorDoneAt?: string; completedAt?: string;
  review?: { rating: number; body: string };
}
export interface ServiceRow { id: string; kind: Trade; name: string; priceCents: number; priceType: PriceType }
export interface ListingArea { ownerUserId: string; title: string; address: string; suburb?: string; postcode?: string }

/** Storage for the job board. Every write carries its audit event; nothing here deletes a job or a review. */
export interface MarketStore {
  cards(trade: Trade): Promise<MarketCard[]>;
  card(userId: string, trade: Trade): Promise<MarketCard | undefined>;
  contractorByNumber(no: number): Promise<{ userId: string } | undefined>;
  service(userId: string, serviceId: string): Promise<ServiceRow | undefined>;
  listingArea(listingId: string): Promise<ListingArea | undefined>;
  getJob(id: string): Promise<JobDetail | undefined>;
  listJobs(userId: string): Promise<JobDetail[]>;
  stats(contractorUserId: string): Promise<ContractorStats>;
  setDeclineReason(id: string, contractorId: string, reason: string): Promise<void>;
  proposeTime(id: string, contractorId: string, iso: string, audit: AuditEvent): Promise<boolean>;
  /** Owner agrees the proposed time: it becomes the scheduled time, and a still-proposed job becomes approved. */
  acceptTime(id: string, ownerId: string, audit: AuditEvent): Promise<boolean>;
  rejectTime(id: string, ownerId: string, audit: AuditEvent): Promise<boolean>;
  markDone(id: string, contractorId: string, audit: AuditEvent): Promise<boolean>;
  addReview(id: string, ownerId: string, rating: number, body: string, audit: AuditEvent): Promise<boolean>;
}

/** Tells one person about a job. Supplied by the route (database, preferences, email) and stubbed in tests. It never throws into the action. */
export type JobNotify = (to: string, kind: Kind, job: JobDetail, extra?: Record<string, string>) => Promise<void>;
type Deps = { assignments: AssignmentRepository; store: MarketStore; ids: AssignmentIds; notify: JobNotify };

const priceText = (j: Pick<JobAssignment, "priceCents">) => (j.priceCents === undefined ? undefined : formatPrice(j.priceCents));

function audit(ids: AssignmentIds, actor: Actor, j: { id: string; listingId: string; kind: string }, eventType: string, payload: Record<string, unknown> = {}): AuditEvent {
  return { id: ids.newId(), occurredAt: ids.now(), actorType: "user", actorId: actor.userId, aggregateType: "job_assignment", aggregateId: j.id, eventType, correlationId: ids.newId(), payload: { listingId: j.listingId, kind: j.kind, ...payload } };
}

/** Owner books a contractor directly. Booking creates a job offer: the contractor still accepts, rejects or proposes another time. */
export async function bookContractor(d: Deps, actor: Actor, listingId: string, input: unknown, source: "owner" | "elena" = "owner"): Promise<Result<JobDetail>> {
  if (typeof input !== "object" || input === null) return bad("Send a JSON object.");
  const o = input as Record<string, unknown>;
  const kind = o["kind"];
  if (!isTrade(kind)) return bad("Choose a trade.");
  let contractorId = typeof o["contractorUserId"] === "string" ? o["contractorUserId"] : undefined;
  if (!contractorId && o["contractorNo"] !== undefined) {
    const no = parseContractorNumber(String(o["contractorNo"]));
    contractorId = no === undefined ? undefined : (await d.store.contractorByNumber(no))?.userId;
  }
  if (!contractorId || !UUID.test(contractorId)) return bad("Choose a contractor.");
  const card = await d.store.card(contractorId, kind);
  if (!card || !card.acceptingNew) return bad("That contractor is not taking new jobs for this trade.");
  let extras: { serviceName?: string; priceCents?: number; note?: string; requestedTime?: string; offerSource: "owner" | "elena" } = { offerSource: source };
  if (o["serviceId"] !== undefined) {
    if (typeof o["serviceId"] !== "string" || !UUID.test(o["serviceId"])) return bad("Choose a service from their list.");
    const svc = await d.store.service(contractorId, o["serviceId"]);
    if (!svc || svc.kind !== kind) return bad("Choose a service from their list.");
    extras = { ...extras, serviceName: svc.name, priceCents: svc.priceCents };
  }
  if (o["note"] !== undefined) {
    if (typeof o["note"] !== "string" || o["note"].length > 1000) return bad("The note must be 1000 characters or fewer.");
    if (o["note"].trim()) extras = { ...extras, note: o["note"].trim() };
  }
  if (o["requestedTime"] !== undefined && o["requestedTime"] !== "") {
    const t = futureTime(o["requestedTime"], d.ids.now());
    if (!t) return bad("Choose a time in the future, within the next year.");
    extras = { ...extras, requestedTime: t };
  }
  const r = await inviteContractor(d.assignments, actor, listingId, { kind, contractorUserId: contractorId }, d.ids, extras);
  if (!r.ok) return r;
  const job = await d.store.getJob(r.value.id);
  if (!job) return { ok: false, code: "conflict", message: "The offer was sent but could not be loaded." };
  await d.notify(contractorId, "job_offered", job, { ...(priceText(job) ? { price: `${job.serviceName ?? "price"} ${priceText(job)}` } : {}) });
  return { ok: true, value: job };
}

/** Elena's ranked suggestions for one trade at one of the owner's listings. */
export async function suggestFor(d: Pick<Deps, "store">, actor: Actor, listingId: string, trade: unknown): Promise<Result<Ranked[]>> {
  if (!UUID.test(listingId) || !isTrade(trade)) return bad("Choose a trade.");
  const area = await d.store.listingArea(listingId);
  if (!area || area.ownerUserId !== actor.userId) return notFound;
  return { ok: true, value: rankContractors({ ...(area.suburb ? { suburb: area.suburb } : {}), ...(area.postcode ? { postcode: area.postcode } : {}) }, await d.store.cards(trade), actor.userId).slice(0, 5) };
}

/**
 * "Let Elena choose": offers the job to the best match. This only sends the first offer. Chasing, reminders and negotiating
 * a time are package 2; for now the contractor answers and the owner sees the answer.
 */
export async function chooseForMe(d: Deps, actor: Actor, listingId: string, input: unknown): Promise<Result<{ job: JobDetail; reasons: string[] }>> {
  const kind = typeof input === "object" && input !== null ? (input as Record<string, unknown>)["kind"] : undefined;
  const ranked = await suggestFor(d, actor, listingId, kind);
  if (!ranked.ok) return ranked;
  const tried = new Set((await d.assignments.listForUser(actor.userId, listingId)).filter(a => a.kind === kind).map(a => a.counterpartName));
  for (const r of ranked.value) {
    if (tried.has(r.card.name)) continue; // never ask someone who already declined or is already on this listing
    const booked = await bookContractor(d, actor, listingId, { kind, contractorUserId: r.card.userId }, "elena");
    if (booked.ok) return { ok: true, value: { job: booked.value, reasons: r.reasons } };
  }
  return { ok: false, code: "not_found", message: "No contractor in your area is taking new jobs for this trade yet. Browse the list or invite someone you know." };
}

function futureTime(v: unknown, nowIso: string): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v), now = Date.parse(nowIso);
  return Number.isFinite(t) && t > now && t < now + 366 * 86_400_000 ? new Date(t).toISOString() : undefined;
}

const ACTIONS = ["accept", "decline", "cancel", "complete", "propose_time", "accept_time", "reject_time", "mark_done"] as const;
type JobAction = typeof ACTIONS[number];

/** One door for everything a party does to a job. The actor's side is checked per action; the id never comes from the body. */
export async function actOnJob(d: Deps, actor: Actor, jobId: string, input: unknown): Promise<Result<JobDetail>> {
  if (!UUID.test(jobId)) return notFound;
  const job = await d.store.getJob(jobId);
  if (!job || (job.ownerUserId !== actor.userId && job.contractorUserId !== actor.userId)) return notFound;
  const o = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const action = o["action"] as JobAction;
  if (!(ACTIONS as readonly unknown[]).includes(action)) return bad("Unknown action.");
  const isOwner = job.ownerUserId === actor.userId;
  const other = isOwner ? job.contractorUserId : job.ownerUserId;
  const fresh = async (): Promise<Result<JobDetail>> => { const j = await d.store.getJob(jobId); return j ? { ok: true, value: j } : notFound; };
  const stale: Failure = { ok: false, code: "conflict", message: "This job changed. Refresh and try again." };

  if (action === "accept" || action === "decline" || action === "cancel" || action === "complete") {
    let reason = "";
    if (action === "decline") {
      reason = typeof o["reason"] === "string" ? o["reason"].trim() : "";
      if (reason.length < 3 || reason.length > 500) return bad("Tell the owner why in a few words (up to 500 characters).");
    }
    const r = await respondToAssignment(d.assignments, actor, jobId, { action }, d.ids);
    if (!r.ok) return r;
    if (action === "decline") await d.store.setDeclineReason(jobId, actor.userId, reason);
    const j = await fresh();
    if (!j.ok) return j;
    if (action === "accept") await d.notify(other, "job_accepted", j.value);
    if (action === "decline") await d.notify(other, "job_declined", j.value, { reason });
    return j;
  }

  if (action === "propose_time") {
    if (isOwner) return { ok: false, code: "forbidden", message: "You cannot do that on this job." };
    if (job.status !== "proposed" && job.status !== "approved") return { ok: false, code: "conflict", message: `This job is ${job.status}, so it cannot be changed that way.` };
    const t = futureTime(o["time"], d.ids.now());
    if (!t) return bad("Choose a time in the future, within the next year.");
    if (!(await d.store.proposeTime(jobId, actor.userId, t, audit(d.ids, actor, job, "job.time_proposed", { time: t })))) return stale;
    const j = await fresh();
    if (j.ok) await d.notify(other, "job_time_proposed", j.value, { when: new Date(t).toLocaleString("en-AU", { timeZone: "Australia/Sydney", dateStyle: "medium", timeStyle: "short" }) });
    return j;
  }
  if (action === "accept_time" || action === "reject_time") {
    if (!isOwner) return { ok: false, code: "forbidden", message: "You cannot do that on this job." };
    if (!job.proposedTime || (job.status !== "proposed" && job.status !== "approved")) return { ok: false, code: "conflict", message: "There is no proposed time to answer." };
    const ok = action === "accept_time"
      ? await d.store.acceptTime(jobId, actor.userId, audit(d.ids, actor, job, "job.time_accepted", { time: job.proposedTime }))
      : await d.store.rejectTime(jobId, actor.userId, audit(d.ids, actor, job, "job.time_rejected"));
    if (!ok) return stale;
    const j = await fresh();
    if (j.ok && action === "accept_time") await d.notify(other, "job_time_confirmed", j.value, { when: new Date(job.proposedTime).toLocaleString("en-AU", { timeZone: "Australia/Sydney", dateStyle: "medium", timeStyle: "short" }) });
    return j;
  }
  // mark_done
  if (isOwner) return { ok: false, code: "forbidden", message: "You cannot do that on this job." };
  if (job.status !== "approved") return { ok: false, code: "conflict", message: `This job is ${job.status}, so it cannot be marked done.` };
  if (!(await d.store.markDone(jobId, actor.userId, audit(d.ids, actor, job, "job.marked_done")))) return stale;
  const j = await fresh();
  if (j.ok) await d.notify(other, "job_done", j.value);
  return j;
}

/** The owner rates and comments on a completed job, once. */
export async function reviewJob(d: Deps, actor: Actor, jobId: string, input: unknown): Promise<Result<JobDetail>> {
  if (!UUID.test(jobId)) return notFound;
  const job = await d.store.getJob(jobId);
  if (!job || job.ownerUserId !== actor.userId) return notFound;
  const parsed = parseReview(input);
  if (!parsed.ok) return parsed;
  if (job.status !== "completed") return { ok: false, code: "conflict", message: "You can leave feedback once you have marked the job complete." };
  if (job.review) return { ok: false, code: "conflict", message: "You have already left feedback for this job." };
  if (!(await d.store.addReview(jobId, actor.userId, parsed.value.rating, parsed.value.body, audit(d.ids, actor, job, "job.reviewed", { rating: parsed.value.rating })))) {
    return { ok: false, code: "conflict", message: "You have already left feedback for this job." };
  }
  const j = await d.store.getJob(jobId);
  if (!j) return notFound;
  await d.notify(job.contractorUserId, "job_reviewed", j);
  return { ok: true, value: j };
}

export const jobLabel = (j: Pick<JobAssignment, "jobNumber">): string => (j.jobNumber === undefined ? "Job" : formatJobNo(j.jobNumber));
export type { AssignmentStatus };
