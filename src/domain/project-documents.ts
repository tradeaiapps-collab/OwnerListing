import { createHash } from "node:crypto";
import type { ObjectStoragePort } from "../adapters/object-storage";
import { sniffMime } from "./file-sniff";
import { viewProject, type InvestmentDeps } from "./investment-service";
import type { MaskBox } from "./doc-masking";
import { maskContacts } from "./investment-terms";
import { ownerMayEdit } from "./investor-projects";
import type { Actor, Failure, Result } from "./listing-service";
import type { MalwareScanPort } from "../adapters/malware-scan";

/**
 * Investor project documents (plans, approvals, feasibility studies, contracts, reports). Separate from listing documents.
 * Visibility: private = owner only; team = owner and reviewing staff; investors = also investors who may see the project
 * (viewProject). Everyone else gets "not found". Files are never deleted: a replacement keeps the earlier version on record.
 * Documents are supplied by the owner and are not checked or endorsed by the platform (the page says so).
 */
export const PROJECT_DOC_KINDS = ["plan", "approval", "feasibility", "contract", "report", "other"] as const;
export type ProjectDocKind = (typeof PROJECT_DOC_KINDS)[number];
export const PROJECT_DOC_VISIBILITIES = ["private", "team", "investors"] as const;
export type ProjectDocVisibility = (typeof PROJECT_DOC_VISIBILITIES)[number];
export const PROJECT_DOC_MIMES = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
export const PROJECT_DOC_MAX_BYTES = 50_000_000;
export const PROJECT_DOC_KIND_LABEL: Record<ProjectDocKind, string> = {
  plan: "Plans", approval: "Approvals", feasibility: "Feasibility studies", contract: "Contracts", report: "Reports", other: "Other"
};

export interface ProjectDocRecord {
  id: string; projectId: string; kind: ProjectDocKind; visibility: ProjectDocVisibility; title: string; uploadedBy: string;
  contentType: string; sizeBytes: number; uploadedAt: string; supersedesId?: string;
}
/**
 * One revision of a document's address masking. Insert only: every save is a new revision and the latest one counts, so an edit after
 * confirmation un-confirms the document until it is confirmed again. Investors see a document only while its latest revision is confirmed.
 */
export interface MaskRevision {
  id: string; documentId: string; revision: number; boxes: MaskBox[]; terms: string[]; pageCount: number; textFound: boolean;
  confirmed: boolean; actorId: string; createdAt: string;
}
export type MaskingStatus = "not_needed" | "pending" | "confirmed";
export interface NewProjectDoc { record: ProjectDocRecord; storageKey: string; sha256: string }
export interface StaffView { staffId: string }

/** Insert only. */
export interface ProjectDocStore {
  /** Every version, oldest first. */
  documentsFor(projectId: string): Promise<ProjectDocRecord[]>;
  documentById(id: string): Promise<ProjectDocRecord | undefined>;
  storedFile(id: string): Promise<{ storageKey: string; contentType: string } | undefined>;
  addDocument(d: NewProjectDoc): Promise<void>;
  /** Investor-visible current documents whose latest masking revision is missing or not confirmed, oldest first (at most 200). */
  unconfirmedInvestorDocs(): Promise<ProjectDocRecord[]>;
  /** Latest masking revision, if any. */
  latestMask(documentId: string): Promise<MaskRevision | undefined>;
  /** False when that revision number already exists (someone saved first). */
  addMask(r: MaskRevision): Promise<boolean>;
  bytesUploadedSince(userId: string, sinceIso: string): Promise<number | undefined>;
}

const notFound = (message = "Not found."): Failure => ({ ok: false, code: "not_found", message });
const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });

export type Viewer = "owner" | "staff" | "investor" | null;

/** Which of the three groups this person is in for the project. Investors must pass viewProject (approved, category allowed). */
export async function viewerOf(deps: InvestmentDeps, actor: Actor | null, projectId: string, ownerUserId: string, staff?: StaffView): Promise<Viewer> {
  if (actor && actor.userId === ownerUserId) return "owner";
  if (staff) return "staff";
  if (actor && (await viewProject(deps, actor, projectId)).ok) return "investor";
  return null;
}

export const mayViewDoc = (viewer: Viewer, v: ProjectDocVisibility): boolean =>
  viewer === "owner" || (viewer === "staff" && v !== "private") || (viewer === "investor" && v === "investors");

/** `masking` is "pending" until staff confirm the address masking of an investor-visible document (see project-document-masking). */
export interface ProjectDocView extends Omit<ProjectDocRecord, "uploadedBy"> { current: boolean; masking: MaskingStatus }
export interface ProjectDocList { documents: ProjectDocView[]; canManage: boolean }

/** Documents this viewer may see, current versions first-class; the owner also gets earlier versions (current: false). */
export async function listProjectDocuments(
  deps: InvestmentDeps, store: ProjectDocStore, actor: Actor | null, projectId: string, staff?: StaffView
): Promise<Result<ProjectDocList>> {
  const p = await deps.repo.getProject(projectId);
  if (!p) return notFound("Project not found.");
  const viewer = await viewerOf(deps, actor, projectId, p.ownerUserId, staff);
  if (!viewer) return notFound("Project not found.");
  const all = await store.documentsFor(projectId);
  const replaced = new Set(all.map(d => d.supersedesId).filter((x): x is string => !!x));
  const visible = all.filter(d => mayViewDoc(viewer, d.visibility) && (viewer === "owner" || !replaced.has(d.id)));
  const withMask = await Promise.all(visible.map(async d => {
    const masking: MaskingStatus = d.visibility !== "investors" ? "not_needed" : (await store.latestMask(d.id))?.confirmed ? "confirmed" : "pending";
    return { d, masking };
  }));
  const documents = withMask
    // An investor never sees a document whose address masking has not been confirmed by staff.
    .filter(({ masking }) => viewer !== "investor" || masking === "confirmed")
    .map(({ d: { uploadedBy: _u, ...d }, masking }) => ({ ...d, current: !replaced.has(d.id), masking }))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.uploadedAt.localeCompare(a.uploadedAt));
  return { ok: true, value: { documents, canManage: viewer === "owner" && ownerMayEdit(p) } };
}

/** Cheap checks before the body is read: providers ready, project exists, caller owns it, project still editable. */
export async function precheckProjectDoc(
  deps: InvestmentDeps, ports: { storage: ObjectStoragePort; scanner: MalwareScanPort }, actor: Actor, projectId: string
): Promise<Failure | undefined> {
  if (!ports.storage.configured || !ports.scanner.configured) return fail("unavailable", "Document upload is not available yet.");
  const p = await deps.repo.getProject(projectId);
  if (!p || p.ownerUserId !== actor.userId) return notFound("Project not found.");
  if (!ownerMayEdit(p)) return fail("conflict", "Documents of a rejected project cannot be changed.");
  return undefined;
}

export interface ProjectDocInput {
  kind: string; visibility: string; title: string; declaredMime: string; bytes: Uint8Array; supersedesId?: string;
}

/** Owner only. Order: role, kind/visibility/title, type from the bytes, size, replacement, malware scan (fail closed), storage, record. */
export async function uploadProjectDocument(
  deps: InvestmentDeps, store: ProjectDocStore, ports: { storage: ObjectStoragePort; scanner: MalwareScanPort },
  actor: Actor, projectId: string, input: ProjectDocInput
): Promise<Result<{ id: string }>> {
  const early = await precheckProjectDoc(deps, ports, actor, projectId);
  if (early) return early;
  if (!(PROJECT_DOC_KINDS as readonly string[]).includes(input.kind)) return fail("invalid", "Choose what kind of document this is.");
  if (!(PROJECT_DOC_VISIBILITIES as readonly string[]).includes(input.visibility)) return fail("invalid", "Choose who can see this document.");
  const title = input.title.trim();
  if (title.length < 2 || title.length > 120) return fail("invalid", "Give the document a title of 2 to 120 characters.");
  // Investors see the title, so it follows the same no-contact-details rule as the project text.
  if (maskContacts(title).masked) return fail("invalid", "The title cannot contain emails, phone numbers or links.");
  if (input.bytes.length === 0) return fail("invalid", "The file is empty.");
  if (input.bytes.length > PROJECT_DOC_MAX_BYTES) return fail("invalid", "Each document must be 50 MB or smaller.");
  if (!(PROJECT_DOC_MIMES as readonly string[]).includes(input.declaredMime)) return fail("invalid", "Only PDF, JPEG, PNG and WebP files can be added.");
  if (sniffMime(input.bytes) !== input.declaredMime) return fail("invalid", "The file's contents do not match its type.");

  let previous: ProjectDocRecord | undefined;
  if (input.supersedesId) {
    previous = await store.documentById(input.supersedesId);
    if (!previous || previous.projectId !== projectId) return notFound("Earlier version not found.");
    if ((await store.documentsFor(projectId)).some(d => d.supersedesId === previous!.id)) return fail("conflict", "Only the current version can be replaced.");
    if (previous.kind !== input.kind) return fail("invalid", "A new version must be the same kind of document.");
  }
  try {
    if ((await ports.scanner.scan(input.bytes)) !== "clean") return fail("invalid", "The file did not pass the security scan.");
  } catch { return fail("unavailable", "Document upload is not available right now."); }

  const id = deps.newId(), storageKey = `investments/${projectId}/${deps.newId()}`;
  try { await ports.storage.put(storageKey, input.bytes, input.declaredMime); }
  catch { return fail("unavailable", "Document upload is not available right now."); }
  const record: ProjectDocRecord = {
    id, projectId, kind: input.kind as ProjectDocKind, visibility: input.visibility as ProjectDocVisibility, title, uploadedBy: actor.userId,
    contentType: input.declaredMime, sizeBytes: input.bytes.length, uploadedAt: deps.now(), ...(previous ? { supersedesId: previous.id } : {})
  };
  try { await store.addDocument({ record, storageKey, sha256: createHash("sha256").update(input.bytes).digest("hex") }); }
  catch {
    console.error(`project document upload: not recorded, orphaned storage key ${storageKey}`);
    return fail(previous ? "conflict" : "unavailable", previous ? "That document was just replaced. Reload and try again." : "Document upload is not available right now.");
  }
  await deps.appendAudit({
    id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId: actor.userId, aggregateType: "investment_project", aggregateId: projectId,
    eventType: previous ? "investment.project_document_replaced" : "investment.project_document_uploaded", correlationId: deps.newId(),
    payload: { documentId: id, kind: input.kind, visibility: input.visibility, sizeBytes: input.bytes.length, ...(previous ? { replacesId: previous.id } : {}) }
  });
  return { ok: true, value: { id } };
}

/**
 * Original bytes of one document. Same visibility rules as the list; an earlier version is served to the owner only. Staff views are
 * logged. Investors never get the original file (they read the masked page images instead), so for them this is "not found".
 */
export async function readProjectDocument(
  deps: InvestmentDeps, store: ProjectDocStore, storage: ObjectStoragePort, actor: Actor | null, docId: string, staff?: StaffView
): Promise<Result<{ bytes: Uint8Array; contentType: string; title: string }>> {
  const doc = await store.documentById(docId);
  const p = doc ? await deps.repo.getProject(doc.projectId) : undefined;
  if (!doc || !p) return notFound("Document not found.");
  const viewer = await viewerOf(deps, actor, p.id, p.ownerUserId, staff);
  if (!viewer || viewer === "investor" || !mayViewDoc(viewer, doc.visibility)) return notFound("Document not found.");
  if (viewer !== "owner" && (await store.documentsFor(p.id)).some(d => d.supersedesId === doc.id)) return notFound("Document not found.");
  const file = await store.storedFile(docId);
  if (!file) return notFound("Document not found.");
  if (!storage.configured) return fail("unavailable", "File storage is not configured.");
  let bytes: Uint8Array;
  try { bytes = await storage.get(file.storageKey); } catch { return fail("unavailable", "The document could not be read right now."); }
  if (viewer === "staff") {
    await deps.appendAudit({ id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId: staff!.staffId, aggregateType: "investment_project", aggregateId: p.id,
      eventType: "investment.project_document_viewed_by_staff", correlationId: deps.newId(), payload: { documentId: docId } });
  }
  return { ok: true, value: { bytes, contentType: file.contentType, title: doc.title } };
}

export function createInMemoryProjectDocStore() {
  const rows: (NewProjectDoc & { bytes?: number })[] = [];
  const masks: MaskRevision[] = [];
  const store: ProjectDocStore = {
    async documentsFor(id) { return rows.filter(r => r.record.projectId === id).map(r => r.record); },
    async documentById(id) { return rows.find(r => r.record.id === id)?.record; },
    async storedFile(id) { const r = rows.find(x => x.record.id === id); return r ? { storageKey: r.storageKey, contentType: r.record.contentType } : undefined; },
    async addDocument(d) {
      if (d.record.supersedesId && rows.some(r => r.record.supersedesId === d.record.supersedesId)) throw new Error("already replaced");
      rows.push(d);
    },
    async unconfirmedInvestorDocs() {
      const replaced = new Set(rows.map(r => r.record.supersedesId).filter(Boolean));
      const out: ProjectDocRecord[] = [];
      for (const r of rows) {
        if (r.record.visibility !== "investors" || replaced.has(r.record.id)) continue;
        if (!(await store.latestMask(r.record.id))?.confirmed) out.push(r.record);
      }
      return out.slice(0, 200);
    },
    async latestMask(id) { return masks.filter(m => m.documentId === id).sort((a, b) => b.revision - a.revision)[0]; },
    async addMask(r) {
      if (masks.some(m => m.documentId === r.documentId && m.revision === r.revision)) return false;
      masks.push(r); return true;
    },
    async bytesUploadedSince(userId) { return rows.filter(r => r.record.uploadedBy === userId).reduce((n, r) => n + r.record.sizeBytes, 0); }
  };
  return { store, rows, masks };
}
