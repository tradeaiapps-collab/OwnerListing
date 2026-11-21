import type { ObjectStoragePort } from "../adapters/object-storage";
import { readBrand } from "../config/brand";
import { autoMaskBoxes, maskTitle, cleanTerms, uncoveredAuto, validateBoxes, type MaskBox, type PageText } from "./doc-masking";
import type { InvestmentDeps } from "./investment-service";
import type { Actor, Failure, Result } from "./listing-service";
import { mayViewDoc, viewerOf, type MaskRevision, type ProjectDocRecord, type ProjectDocStore, type StaffView } from "./project-documents";

/**
 * In-site document viewing with address masking.
 * - Investors never receive the original file. They get one flat image per page, with the confirmed masks burned into the pixels and a
 *   faint watermark naming the viewer, and only while staff have confirmed the masking (project approved AND masking confirmed).
 * - Elena's auto-mask proposes boxes; reviewing staff run it, add or remove boxes by hand, and confirm. Confirming runs the detection
 *   again and refuses while an address-like area is not covered, unless staff explicitly allow it (recorded).
 * - Owners and reviewing staff can see the original pages. A screenshot of a page cannot be prevented, only traced by the watermark.
 */
export interface PageRenderer {
  analyse(bytes: Uint8Array, mime: string): Promise<{ pageCount: number; pages: PageText[]; textFound: boolean }>;
  render(bytes: Uint8Array, mime: string, page: number, opts: { boxes: readonly MaskBox[]; watermark?: string }): Promise<{ image: Uint8Array; contentType: string; pageCount: number }>;
}
export interface MaskPorts { storage: ObjectStoragePort; renderer: PageRenderer }

const notFound = (m = "Document not found."): Failure => ({ ok: false, code: "not_found", message: m });
const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });

interface Loaded { doc: ProjectDocRecord; projectId: string; ownerUserId: string; viewer: "owner" | "staff" | "investor" }

async function load(deps: InvestmentDeps, store: ProjectDocStore, actor: Actor | null, docId: string, staff?: StaffView): Promise<Loaded | Failure> {
  const doc = await store.documentById(docId);
  const p = doc ? await deps.repo.getProject(doc.projectId) : undefined;
  if (!doc || !p) return notFound();
  const viewer = await viewerOf(deps, actor, p.id, p.ownerUserId, staff);
  if (!viewer || !mayViewDoc(viewer, doc.visibility)) return notFound();
  if (viewer !== "owner" && (await store.documentsFor(p.id)).some(d => d.supersedesId === doc.id)) return notFound();
  return { doc, projectId: p.id, ownerUserId: p.ownerUserId, viewer };
}
const isFail = (x: Loaded | Failure): x is Failure => "ok" in x;

async function original(store: ProjectDocStore, ports: MaskPorts, doc: ProjectDocRecord): Promise<Result<{ bytes: Uint8Array; mime: string }>> {
  const file = await store.storedFile(doc.id);
  if (!file) return notFound();
  if (!ports.storage.configured) return fail("unavailable", "File storage is not configured.");
  try { return { ok: true, value: { bytes: await ports.storage.get(file.storageKey), mime: file.contentType } }; }
  catch { return fail("unavailable", "The document could not be read right now."); }
}

export interface PageInfo { title: string; pageCount: number; masked: boolean }

/** How many pages, and whether this viewer sees the masked version. Investors need a confirmed mask; anyone else gets "not found". */
export async function documentPageInfo(
  deps: InvestmentDeps, store: ProjectDocStore, ports: MaskPorts, actor: Actor | null, docId: string, staff?: StaffView
): Promise<Result<PageInfo>> {
  const l = await load(deps, store, actor, docId, staff);
  if (isFail(l)) return l;
  const mask = await store.latestMask(docId);
  if (l.viewer === "investor") {
    if (!mask?.confirmed) return notFound();
    return { ok: true, value: { title: maskTitle(l.doc.title, mask.terms), pageCount: mask.pageCount, masked: true } };
  }
  if (mask) return { ok: true, value: { title: l.doc.title, pageCount: mask.pageCount, masked: false } };
  const o = await original(store, ports, l.doc);
  if (!o.ok) return o;
  try { return { ok: true, value: { title: l.doc.title, pageCount: (await ports.renderer.analyse(o.value.bytes, o.value.mime)).pageCount, masked: false } }; }
  catch { return fail("unavailable", "The document could not be read right now."); }
}

export interface PageOpts { /** Owner or staff: show the version investors see (needs a confirmed mask). */ asInvestor?: boolean }

/** One page as a WebP image. Investors: masked and watermarked. Owner and staff: the original page, watermarked, unless asInvestor. */
export async function renderDocumentPage(
  deps: InvestmentDeps, store: ProjectDocStore, ports: MaskPorts, actor: Actor | null, docId: string, pageNo: number, staff?: StaffView, opts: PageOpts = {}
): Promise<Result<{ image: Uint8Array; contentType: string }>> {
  if (!Number.isInteger(pageNo) || pageNo < 1) return notFound("Page not found.");
  const l = await load(deps, store, actor, docId, staff);
  if (isFail(l)) return l;
  const mask = await store.latestMask(docId);
  const masked = l.viewer === "investor" || opts.asInvestor === true;
  if (masked && !mask?.confirmed) return notFound();
  if (pageNo > (mask?.pageCount ?? Infinity)) return notFound("Page not found.");
  const o = await original(store, ports, l.doc);
  if (!o.ok) return o;
  const who = l.viewer === "staff" ? staff!.staffId : actor!.userId;
  const watermark = `${readBrand().name} · ${who.slice(0, 8)} · ${deps.now().slice(0, 10)}`;
  try {
    const r = await ports.renderer.render(o.value.bytes, o.value.mime, pageNo, { boxes: masked ? mask!.boxes : [], watermark });
    return { ok: true, value: { image: r.image, contentType: r.contentType } };
  } catch { return notFound("Page not found."); }
}

// ---- Staff: auto mask, manual boxes, confirm -------------------------------------------------------------------------

export interface MaskState {
  document: { id: string; projectId: string; title: string; kind: string; contentType: string };
  pageCount: number; textFound: boolean; revision: number; confirmed: boolean; boxes: MaskBox[]; terms: string[];
}

async function staffLoad(deps: InvestmentDeps, store: ProjectDocStore, staff: StaffView, docId: string): Promise<Loaded | Failure> {
  const l = await load(deps, store, null, docId, staff);
  if (isFail(l)) return l;
  if (l.doc.visibility !== "investors") return fail("invalid", "Only documents shared with investors need masking.");
  return l;
}

const audit = (deps: InvestmentDeps, staff: StaffView, projectId: string, eventType: string, payload: Record<string, unknown>) =>
  deps.appendAudit({ id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId: staff.staffId, aggregateType: "investment_project", aggregateId: projectId, eventType, correlationId: deps.newId(), payload });

/** The current masking of a document for the review screen. Opening it is logged (staff see the original pages). */
export async function maskState(deps: InvestmentDeps, store: ProjectDocStore, ports: MaskPorts, staff: StaffView, docId: string): Promise<Result<MaskState>> {
  const l = await staffLoad(deps, store, staff, docId);
  if (isFail(l)) return l;
  const rev = await store.latestMask(docId);
  const base = { document: { id: l.doc.id, projectId: l.projectId, title: l.doc.title, kind: l.doc.kind, contentType: l.doc.contentType } };
  await audit(deps, staff, l.projectId, "investment.project_document_viewed_by_staff", { documentId: docId, via: "masking" });
  if (rev) return { ok: true, value: { ...base, pageCount: rev.pageCount, textFound: rev.textFound, revision: rev.revision, confirmed: rev.confirmed, boxes: rev.boxes, terms: rev.terms } };
  return { ok: true, value: { ...base, pageCount: 0, textFound: false, revision: 0, confirmed: false, boxes: [], terms: [] } };
}

async function analyseDoc(store: ProjectDocStore, ports: MaskPorts, doc: ProjectDocRecord) {
  const o = await original(store, ports, doc);
  if (!o.ok) return o;
  try { return { ok: true as const, value: await ports.renderer.analyse(o.value.bytes, o.value.mime) }; }
  catch { return fail("invalid", "This file could not be read. Ask the owner to upload it again."); }
}

/** Elena's auto-mask: finds addresses (and the admin's extra terms), keeps manual boxes, saves an unconfirmed revision. */
export async function runAutoMask(
  deps: InvestmentDeps, store: ProjectDocStore, ports: MaskPorts, staff: StaffView, docId: string, input: { expectedRevision: number; terms?: string[] }
): Promise<Result<MaskState>> {
  const l = await staffLoad(deps, store, staff, docId);
  if (isFail(l)) return l;
  const prev = await store.latestMask(docId);
  if ((prev?.revision ?? 0) !== input.expectedRevision) return fail("conflict", "Someone else changed this masking. Reload and try again.");
  const a = await analyseDoc(store, ports, l.doc);
  if (!a.ok) return a;
  const terms = cleanTerms(input.terms ?? prev?.terms ?? []);
  const auto = autoMaskBoxes(a.value.pages, terms);
  const boxes = [...(prev?.boxes.filter(b => b.source === "manual") ?? []), ...auto];
  const rev: MaskRevision = {
    id: deps.newId(), documentId: docId, revision: (prev?.revision ?? 0) + 1, boxes, terms, pageCount: a.value.pageCount, textFound: a.value.textFound,
    confirmed: false, actorId: staff.staffId, createdAt: deps.now()
  };
  if (!(await store.addMask(rev))) return fail("conflict", "Someone else changed this masking. Reload and try again.");
  await audit(deps, staff, l.projectId, "investment.project_document_auto_masked", { documentId: docId, revision: rev.revision, autoBoxes: auto.length, textFound: a.value.textFound });
  return { ok: true, value: { document: { id: l.doc.id, projectId: l.projectId, title: l.doc.title, kind: l.doc.kind, contentType: l.doc.contentType }, pageCount: rev.pageCount, textFound: rev.textFound, revision: rev.revision, confirmed: false, boxes, terms } };
}

export interface SaveMaskInput { expectedRevision: number; boxes: unknown; terms?: string[]; confirm?: boolean; allowUncovered?: boolean }

/**
 * Staff save the box list as drawn (auto and manual boxes can be added or removed), and may confirm. Confirming re-runs the address
 * detection on the original: while some detected area is not covered by a saved box it is refused ("conflict"), unless the reviewer
 * ticks "allowUncovered" (recorded in the audit log). A document with no readable text can only be confirmed by a person, by hand.
 */
export async function saveMask(
  deps: InvestmentDeps, store: ProjectDocStore, ports: MaskPorts, staff: StaffView, docId: string, input: SaveMaskInput
): Promise<Result<MaskState & { uncovered: number }>> {
  const l = await staffLoad(deps, store, staff, docId);
  if (isFail(l)) return l;
  const prev = await store.latestMask(docId);
  if ((prev?.revision ?? 0) !== input.expectedRevision) return fail("conflict", "Someone else changed this masking. Reload and try again.");
  const a = await analyseDoc(store, ports, l.doc);
  if (!a.ok) return a;
  const v = validateBoxes(input.boxes, a.value.pageCount);
  if (!v.ok) return fail("invalid", v.error);
  const terms = cleanTerms(input.terms ?? prev?.terms ?? []);
  const missed = uncoveredAuto(autoMaskBoxes(a.value.pages, terms), v.boxes);
  if (input.confirm && missed.length > 0 && !input.allowUncovered) {
    return fail("conflict", `${missed.length} address-like area${missed.length === 1 ? " is" : "s are"} not masked. Run Elena's auto-mask again, or confirm anyway if they are not addresses.`);
  }
  const rev: MaskRevision = {
    id: deps.newId(), documentId: docId, revision: (prev?.revision ?? 0) + 1, boxes: v.boxes, terms, pageCount: a.value.pageCount, textFound: a.value.textFound,
    confirmed: input.confirm === true, actorId: staff.staffId, createdAt: deps.now()
  };
  if (!(await store.addMask(rev))) return fail("conflict", "Someone else changed this masking. Reload and try again.");
  await audit(deps, staff, l.projectId, rev.confirmed ? "investment.project_document_mask_confirmed" : "investment.project_document_mask_saved", {
    documentId: docId, revision: rev.revision, boxes: v.boxes.length, manualBoxes: v.boxes.filter(b => b.source === "manual").length, uncovered: missed.length,
    ...(input.allowUncovered && missed.length ? { allowedUncovered: true } : {}), textFound: a.value.textFound
  });
  return { ok: true, value: { document: { id: l.doc.id, projectId: l.projectId, title: l.doc.title, kind: l.doc.kind, contentType: l.doc.contentType }, pageCount: rev.pageCount, textFound: rev.textFound, revision: rev.revision, confirmed: rev.confirmed, boxes: rev.boxes, terms, uncovered: missed.length } };
}

export interface ToMask { documentId: string; projectId: string; projectTitle: string; projectStatus: string; title: string; kind: string; uploadedAt: string; contentType: string }

/** The review queue: investor-visible documents whose address masking is not yet confirmed. */
export async function documentsToMask(deps: InvestmentDeps, store: ProjectDocStore): Promise<ToMask[]> {
  const out: ToMask[] = [];
  for (const d of await store.unconfirmedInvestorDocs()) {
    const p = await deps.repo.getProject(d.projectId);
    if (p) out.push({ documentId: d.id, projectId: p.id, projectTitle: p.title, projectStatus: p.status, title: d.title, kind: d.kind, uploadedAt: d.uploadedAt, contentType: d.contentType });
  }
  return out;
}
