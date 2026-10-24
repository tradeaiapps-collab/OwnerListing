import type { AuditEvent } from "./audit";
import {
  canSubmitAgain, imagesDueForDeletion, reviewSubmission, validateSubmission,
  type IdDocumentKind, type IdSubmission, type ReviewChecklist, type ReviewOutcome
} from "./id-verification";
import { fail, type Actor, type Result } from "./listing-service";
import { staffCan, type StaffActor } from "./staff-access";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export type ImageKind = "front" | "back" | "selfie";

/** Private storage for ID images. Absent means ID submission is not set up, so it stays blocked (fail closed). */
export interface FileStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
}

export interface PendingItem { submission: IdSubmission; accountName: string }

export interface IdRepository {
  /** False if the person already has a submission waiting. */
  insert(s: IdSubmission): Promise<boolean>;
  get(id: string): Promise<IdSubmission | undefined>;
  latestForUser(userId: string): Promise<IdSubmission | undefined>;
  recentSubmittedAt(userId: string, sinceIso: string): Promise<string[]>;
  listPending(): Promise<PendingItem[]>;
  logAccess(submissionId: string, staffId: string, purpose: string, at: string): Promise<void>;
  /**
   * Saves a reviewer decision only if the stored submission is still pending with the same approvals (so two reviewers
   * cannot overwrite each other). On approval it also marks the account ID verified. Returns false if it lost the race.
   */
  decide(next: IdSubmission, prev: IdSubmission, staffId: string, outcome: ReviewOutcome, checklist: ReviewChecklist): Promise<boolean>;
  /** Decided submissions whose images have not been deleted yet. */
  withImagesToDelete(): Promise<IdSubmission[]>;
  markImagesDeleted(id: string, at: string): Promise<void>;
}

export interface IdDeps {
  ids: IdRepository;
  files: FileStore | undefined;
  /** The staff role comes from the database every time, never from the session. */
  staffFor: (userId: string) => Promise<StaffActor | undefined>;
  appendAudit: (e: AuditEvent) => Promise<void>;
  now: () => string;
  newId: () => string;
}

export function sniffImage(b: Uint8Array): "image/jpeg" | "image/png" | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "image/png";
  return null;
}

export interface SubmitInput {
  documentKind: IdDocumentKind;
  documentCountry: string;
  expiryDate: string;
  front?: Uint8Array;
  back?: Uint8Array;
  selfie?: Uint8Array;
  /** A declaration from the app. The server cannot prove it, so the reviewer still judges the selfie. */
  selfieCapturedInApp: boolean;
}

const audit = (deps: IdDeps, actorId: string, aggregateId: string, eventType: string, payload: Record<string, unknown> = {}): Promise<void> =>
  deps.appendAudit({
    id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId,
    aggregateType: "id_submission", aggregateId, eventType, correlationId: deps.newId(), payload
  });

export async function submitId(deps: IdDeps, actor: Actor, input: SubmitInput): Promise<Result<{ id: string }>> {
  if (!deps.files) return fail("unavailable", "ID checks are not available yet.");
  const kinds: readonly string[] = ["drivers_licence", "passport", "other_government_id"];
  if (!kinds.includes(input.documentKind)) return fail("invalid", "Choose a document type.");

  const now = deps.now();
  const images: [ImageKind, Uint8Array | undefined][] = [["front", input.front], ["back", input.back], ["selfie", input.selfie]];
  for (const [, bytes] of images) {
    if (bytes && (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES)) return fail("invalid", "Each image must be a JPEG or PNG under 5 MB.");
    if (bytes && sniffImage(bytes) === null) return fail("invalid", "Each image must be a JPEG or PNG under 5 MB.");
  }

  const since = new Date(new Date(now).getTime() - 24 * 3_600_000).toISOString();
  if (!canSubmitAgain(await deps.ids.recentSubmittedAt(actor.userId, since), now)) {
    return fail("rate_limited", "Too many ID submissions today. Try again tomorrow.");
  }

  const id = deps.newId();
  const keys: Partial<Record<ImageKind, string>> = {};
  const draft: IdSubmission = {
    id, userId: actor.userId, documentKind: input.documentKind, documentCountry: input.documentCountry.trim().toUpperCase(),
    expiryDate: input.expiryDate, selfieCapturedInApp: input.selfieCapturedInApp, submittedAt: now, status: "pending", approvals: [],
    ...(input.front ? { frontImageRef: "x" } : {}), ...(input.selfie ? { selfieRef: "x" } : {}), ...(input.back ? { backImageRef: "x" } : {})
  };
  const problems = validateSubmission(draft, now.slice(0, 10));
  if (problems.length > 0) return fail("invalid", problems[0] ?? "Invalid submission.");

  const stored: string[] = [];
  try {
    for (const [kind, bytes] of images) {
      if (!bytes) continue;
      const key = deps.newId();
      await deps.files.put(key, bytes);
      stored.push(key);
      keys[kind] = key;
    }
    const sub: IdSubmission = {
      ...draft,
      frontImageRef: keys.front!, selfieRef: keys.selfie!,
      ...(keys.back ? { backImageRef: keys.back } : {})
    };
    if (!(await deps.ids.insert(sub))) throw new Error("pending");
  } catch (e) {
    await Promise.all(stored.map(k => deps.files!.delete(k).catch(() => {})));
    if (e instanceof Error && e.message === "pending") return fail("conflict", "You already have an ID check waiting for review.");
    throw e;
  }
  await audit(deps, actor.userId, id, "id.submitted", { documentKind: draft.documentKind, documentCountry: draft.documentCountry });
  return { ok: true, value: { id } };
}

export async function myIdStatus(deps: IdDeps, actor: Actor): Promise<{ status: IdSubmission["status"] | "none" }> {
  const s = await deps.ids.latestForUser(actor.userId);
  return { status: s?.status ?? "none" };
}

async function requireReviewer(deps: IdDeps, actor: Actor): Promise<Result<StaffActor>> {
  const staff = await deps.staffFor(actor.userId);
  if (!staff || !staffCan(staff, "identity.review")) return fail("forbidden", "Not allowed.");
  return { ok: true, value: staff };
}

export async function pendingQueue(deps: IdDeps, actor: Actor): Promise<Result<PendingItem[]>> {
  const r = await requireReviewer(deps, actor);
  if (!r.ok) return r;
  return { ok: true, value: await deps.ids.listPending() };
}

/** Returns an image to a reviewer. The access is written to the log before any bytes are returned. */
export async function viewIdImage(
  deps: IdDeps, actor: Actor, submissionId: string, which: ImageKind
): Promise<Result<{ bytes: Uint8Array; contentType: "image/jpeg" | "image/png" }>> {
  const r = await requireReviewer(deps, actor);
  if (!r.ok) return r;
  if (!deps.files) return fail("unavailable", "ID checks are not available yet.");
  const s = await deps.ids.get(submissionId);
  if (!s || s.userId === actor.userId) return fail("not_found", "Not found.");
  const ref = which === "front" ? s.frontImageRef : which === "back" ? s.backImageRef : s.selfieRef;
  if (!ref) return fail("not_found", "Image not available.");
  await deps.ids.logAccess(s.id, actor.userId, `identity review: ${which}`, deps.now());
  const bytes = await deps.files.get(ref);
  const contentType = bytes ? sniffImage(bytes) : null;
  if (!bytes || !contentType) return fail("not_found", "Image not available.");
  return { ok: true, value: { bytes, contentType } };
}

export async function reviewId(
  deps: IdDeps, actor: Actor, submissionId: string, outcome: ReviewOutcome, checklist: ReviewChecklist
): Promise<Result<{ status: IdSubmission["status"] }>> {
  const r = await requireReviewer(deps, actor);
  if (!r.ok) return r;
  const prev = await deps.ids.get(submissionId);
  if (!prev) return fail("not_found", "Not found.");
  if (prev.userId === actor.userId) return fail("forbidden", "You cannot review your own ID check.");
  if (prev.status !== "pending") return fail("conflict", "This submission is not waiting for review.");
  if (outcome === "approve" && prev.approvals.includes(actor.userId)) return fail("conflict", "A different reviewer must give the second approval.");

  let next: IdSubmission;
  try {
    next = reviewSubmission(prev, r.value, outcome, checklist, deps.now());
  } catch (e) {
    return fail("invalid", e instanceof Error ? e.message : "Invalid review.");
  }
  if (!(await deps.ids.decide(next, prev, actor.userId, outcome, checklist))) {
    return fail("conflict", "Someone else just updated this submission. Reload and try again.");
  }
  await audit(deps, actor.userId, prev.id, "id.reviewed", { outcome, resulting: next.status });
  return { ok: true, value: { status: next.status } };
}

/** Deletes images once the retention period has passed. Keeps only the result. Run on a schedule. */
export async function purgeDueImages(deps: IdDeps): Promise<number> {
  if (!deps.files) return 0;
  const now = deps.now();
  let n = 0;
  for (const s of await deps.ids.withImagesToDelete()) {
    if (!imagesDueForDeletion(s, now)) continue;
    for (const ref of [s.frontImageRef, s.backImageRef, s.selfieRef]) if (ref) await deps.files.delete(ref);
    await deps.ids.markImagesDeleted(s.id, now);
    await audit(deps, "system", s.id, "id.images_deleted");
    n++;
  }
  return n;
}

export function createInMemoryIdRepository(names: Record<string, string> = {}): IdRepository & {
  rows: Map<string, IdSubmission>; accessLog: { submissionId: string; staffId: string }[]; verified: Set<string>; deleted: Set<string>;
} {
  const rows = new Map<string, IdSubmission>();
  const accessLog: { submissionId: string; staffId: string }[] = [];
  const verified = new Set<string>();
  const deleted = new Set<string>();
  return {
    rows, accessLog, verified, deleted,
    async insert(s) {
      if ([...rows.values()].some(r => r.userId === s.userId && r.status === "pending")) return false;
      rows.set(s.id, s);
      return true;
    },
    async get(id) { return rows.get(id); },
    async latestForUser(userId) {
      return [...rows.values()].filter(r => r.userId === userId).sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1))[0];
    },
    async recentSubmittedAt(userId, since) {
      return [...rows.values()].filter(r => r.userId === userId && r.submittedAt >= since).map(r => r.submittedAt);
    },
    async listPending() {
      return [...rows.values()].filter(r => r.status === "pending").map(submission => ({ submission, accountName: names[submission.userId] ?? "" }));
    },
    async logAccess(submissionId, staffId) { accessLog.push({ submissionId, staffId }); },
    async decide(next, prev) {
      const cur = rows.get(prev.id);
      if (!cur || cur.status !== "pending" || cur.approvals.join() !== prev.approvals.join()) return false;
      rows.set(next.id, next);
      if (next.status === "approved") verified.add(next.userId);
      return true;
    },
    async withImagesToDelete() { return [...rows.values()].filter(r => !deleted.has(r.id)); },
    async markImagesDeleted(id) { deleted.add(id); }
  };
}
