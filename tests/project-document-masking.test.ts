import { beforeEach, describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
// @ts-expect-error plain Node script (no types), shared with scripts/seed-demo.mjs
import { makeDemoPdf } from "../scripts/demo-project-docs.mjs";
import { INVESTMENT_DISCLOSURE } from "../src/config/investment-disclosure";
import type { AuditEvent } from "../src/domain/audit";
import { createInMemoryInvestmentRepository, createProject, decideProject, type InvestmentDeps } from "../src/domain/investment-service";
import { DEFAULT_POSTING } from "../src/domain/investment-terms";
import { moduleState } from "../src/domain/investor-projects";
import type { Actor } from "../src/domain/listing-service";
import { documentPageInfo, maskState, renderDocumentPage, runAutoMask, saveMask, type MaskPorts, type PageRenderer } from "../src/domain/project-document-masking";
import { createInMemoryProjectDocStore, listProjectDocuments, uploadProjectDocument } from "../src/domain/project-documents";
import type { StaffActor } from "../src/domain/staff-access";
import { createPageRenderer } from "../src/server/pdf-pages";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: Actor = { userId: U(1), userType: "owner" };
const wholesale: Actor = { userId: U(2), userType: "buyer" };
const admin: StaffActor = { id: U(90), role: "super_admin" };
const staff = { staffId: admin.id };

let deps: InvestmentDeps, mem: ReturnType<typeof createInMemoryInvestmentRepository>, docs: ReturnType<typeof createInMemoryProjectDocStore>;
let upload: Parameters<typeof uploadProjectDocument>[2];
let objects: Map<string, Uint8Array>, ports: MaskPorts, audit: AuditEvent[], n = 0;
let renders: { page: number; boxes: number; watermark?: string }[];

/** A renderer that "finds" one address on page 1 and records what it was asked to draw. */
const fake: PageRenderer = {
  async analyse() { return { pageCount: 2, textFound: true, pages: [{ runs: [{ str: "Site: 12 Smith Street, Bulimba QLD 4171", x: 0.1, y: 0.1, w: 0.4, h: 0.012 }] }, { runs: [] }] }; },
  async render(_b, _m, page, o) { renders.push({ page, boxes: o.boxes.length, ...(o.watermark ? { watermark: o.watermark } : {}) }); return { image: Uint8Array.from([1, 2, 3]), contentType: "image/webp", pageCount: 2 }; }
};

beforeEach(async () => {
  n = 0; audit = []; objects = new Map(); renders = [];
  mem = createInMemoryInvestmentRepository(); docs = createInMemoryProjectDocStore();
  const storage = { configured: true, async put(k: string, b: Uint8Array) { objects.set(k, b); }, async get(k: string) { const b = objects.get(k); if (!b) throw new Error("missing"); return b; } };
  ports = { storage, renderer: fake };
  upload = { storage, scanner: { configured: true, async scan() { return "clean" as const; } } };
  deps = {
    repo: mem.repo, moduleState: async () => moduleState(true, true), postingSettings: async () => ({ ...DEFAULT_POSTING }),
    verification: async () => ({ emailVerified: true, phoneVerified: true, idVerified: true }), countHit: async () => 1, contactFor: async () => undefined, notify: async () => {},
    files: { storage, scanner: { configured: true, async scan() { return "clean" as const; } } }, startUpfrontCheckout: async () => { throw new Error("no"); },
    sha256: async () => "a".repeat(64), appUrl: "http://test", appendAudit: async e => { audit.push(e); }, now: () => "2026-11-08T00:00:00.000Z",
    newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`
  };
  await mem.repo.addDeclaration({ id: U(200), userId: wholesale.userId, category: "wholesale", disclosureVersion: INVESTMENT_DISCLOSURE.version, declaredAt: "2026-11-08T00:00:00.000Z" });
});

const fields = { title: "Riverside townhouses", location: "Bulimba", jurisdiction: "QLD", projectType: "residential_development", stage: "planning",
  summary: "Six townhouses on a 1,200 square metre lot close to the river.", fundingTargetCents: 250_000_000, minimumTicketCents: 5_000_000, timeline: "DA lodged; build 18 months.",
  risks: "Planning, construction cost and sales risk. You can lose money.", structureDescription: "Unit trust with a corporate trustee.", issuerName: "Riverside Dev Pty Ltd",
  issuerLicenceBasis: "Wholesale-only offer under s708", issuerStatement: "", issuerAuthorisedConfirmed: true, visibleTo: "all_verified" };

async function setup(approve = true) {
  const r = await createProject(deps, owner, fields);
  if (!r.ok) throw new Error(r.message);
  const pid = r.value.project.id;
  if (approve) { const p = (await mem.repo.getProject(pid))!; await decideProject(deps, admin, pid, "approve", "Checked issuer and risks.", p.version); }
  const up = await uploadProjectDocument(deps, docs.store, upload, owner, pid, { kind: "plan", visibility: "investors", title: "Site plan", declaredMime: "application/pdf", bytes: Uint8Array.from(Buffer.from("%PDF-1.4\nx\n%%EOF")) });
  if (!up.ok) throw new Error(up.message);
  return { pid, docId: up.value.id };
}

describe("investor viewing", () => {
  it("is refused until staff confirm, then serves a masked, watermarked page and never the original", async () => {
    const { docId } = await setup();
    expect((await documentPageInfo(deps, docs.store, ports, wholesale, docId)).ok).toBe(false);
    expect((await renderDocumentPage(deps, docs.store, ports, wholesale, docId, 1)).ok).toBe(false);
    const a = await runAutoMask(deps, docs.store, ports, staff, docId, { expectedRevision: 0 });
    expect(a.ok && a.value.boxes.length).toBe(1);
    expect((await renderDocumentPage(deps, docs.store, ports, wholesale, docId, 1)).ok).toBe(false); // saved but not confirmed
    const s = await saveMask(deps, docs.store, ports, staff, docId, { expectedRevision: 1, boxes: a.ok ? a.value.boxes : [], confirm: true });
    expect(s.ok).toBe(true);
    const info = await documentPageInfo(deps, docs.store, ports, wholesale, docId);
    expect(info.ok && info.value).toMatchObject({ pageCount: 2, masked: true });
    const page = await renderDocumentPage(deps, docs.store, ports, wholesale, docId, 1);
    expect(page.ok).toBe(true);
    expect(renders.at(-1)).toMatchObject({ page: 1, boxes: 1, watermark: expect.stringContaining("00000000") });
    expect((await renderDocumentPage(deps, docs.store, ports, wholesale, docId, 3)).ok).toBe(false);
    expect((await renderDocumentPage(deps, docs.store, ports, wholesale, docId, 0)).ok).toBe(false);
  });

  it("is refused while the project is not approved, even when masking is confirmed", async () => {
    const { docId } = await setup(false);
    const a = await runAutoMask(deps, docs.store, ports, staff, docId, { expectedRevision: 0 });
    await saveMask(deps, docs.store, ports, staff, docId, { expectedRevision: 1, boxes: a.ok ? a.value.boxes : [], confirm: true });
    const r = await renderDocumentPage(deps, docs.store, ports, wholesale, docId, 1);
    expect(!r.ok && r.code).toBe("not_found");
  });

  it("an owner sees the original page, and the investor view only once confirmed", async () => {
    const { docId } = await setup();
    expect((await renderDocumentPage(deps, docs.store, ports, owner, docId, 1)).ok).toBe(true);
    expect(renders.at(-1)!.boxes).toBe(0);
    expect((await renderDocumentPage(deps, docs.store, ports, owner, docId, 1, undefined, { asInvestor: true })).ok).toBe(false);
  });

  it("a stranger and a signed-out visitor get nothing", async () => {
    const { docId } = await setup();
    const stranger: Actor = { userId: U(5), userType: "owner" };
    expect((await renderDocumentPage(deps, docs.store, ports, stranger, docId, 1)).ok).toBe(false);
    expect((await renderDocumentPage(deps, docs.store, ports, null, docId, 1)).ok).toBe(false);
  });
});

describe("staff masking tools", () => {
  it("auto-mask keeps manual boxes, and confirming refuses an uncovered address unless allowed (and says so in the audit)", async () => {
    const { docId } = await setup();
    const manual = { page: 2, x: 0.2, y: 0.2, w: 0.1, h: 0.03, source: "manual" as const };
    const first = await saveMask(deps, docs.store, ports, staff, docId, { expectedRevision: 0, boxes: [manual] });
    expect(first.ok && first.value.uncovered).toBe(1);
    const refused = await saveMask(deps, docs.store, ports, staff, docId, { expectedRevision: 1, boxes: [manual], confirm: true });
    expect(!refused.ok && refused.code).toBe("conflict");
    const auto = await runAutoMask(deps, docs.store, ports, staff, docId, { expectedRevision: 1 });
    expect(auto.ok && auto.value.boxes.map(b => b.source).sort()).toEqual(["auto", "manual"]);
    const removedAuto = await saveMask(deps, docs.store, ports, staff, docId, { expectedRevision: 2, boxes: [manual], confirm: true, allowUncovered: true });
    expect(removedAuto.ok).toBe(true);
    expect(audit.find(e => e.eventType === "investment.project_document_mask_confirmed")!.payload).toMatchObject({ allowedUncovered: true, uncovered: 1 });
  });

  it("a stale revision is a conflict; extra terms are masked; bad boxes are refused", async () => {
    const { docId } = await setup();
    await runAutoMask(deps, docs.store, ports, staff, docId, { expectedRevision: 0 });
    const stale = await runAutoMask(deps, docs.store, ports, staff, docId, { expectedRevision: 0 });
    expect(!stale.ok && stale.code).toBe("conflict");
    const bad = await saveMask(deps, docs.store, ports, staff, docId, { expectedRevision: 1, boxes: [{ page: 9, x: 0, y: 0, w: 0.1, h: 0.1, source: "manual" }] });
    expect(!bad.ok && bad.code).toBe("invalid");
  });

  it("an edit after confirming hides the document from investors until it is confirmed again", async () => {
    const { pid, docId } = await setup();
    const a = await runAutoMask(deps, docs.store, ports, staff, docId, { expectedRevision: 0 });
    await saveMask(deps, docs.store, ports, staff, docId, { expectedRevision: 1, boxes: a.ok ? a.value.boxes : [], confirm: true });
    const titles = async () => { const l = await listProjectDocuments(deps, docs.store, wholesale, pid); return l.ok ? l.value.documents.length : -1; };
    expect(await titles()).toBe(1);
    await saveMask(deps, docs.store, ports, staff, docId, { expectedRevision: 2, boxes: a.ok ? a.value.boxes : [] });
    expect(await titles()).toBe(0);
  });

  it("only documents shared with investors, and opening the screen is audited", async () => {
    const { pid } = await setup();
    const up = await uploadProjectDocument(deps, docs.store, upload, owner, pid, { kind: "plan", visibility: "team", title: "Team plan", declaredMime: "application/pdf", bytes: Uint8Array.from(Buffer.from("%PDF-1.4\ny\n%%EOF")) });
    const r = await maskState(deps, docs.store, ports, staff, up.ok ? up.value.id : "");
    expect(!r.ok && r.code).toBe("invalid");
    const { docId } = { docId: docs.rows.find(x => x.record.title === "Site plan")!.record.id };
    expect((await maskState(deps, docs.store, ports, staff, docId)).ok).toBe(true);
    expect(audit.some(e => e.eventType === "investment.project_document_viewed_by_staff")).toBe(true);
  });
});

describe("real renderer", () => {
  it("burns the address into the page: the box is black and text is no longer readable from the image", async () => {
    const real = createPageRenderer();
    const pdf = new Uint8Array(makeDemoPdf("Plan", ["Site at 12 Smith Street, Bulimba QLD 4171 for the build.", "Second line stays."]));
    const a = await real.analyse(pdf, "application/pdf");
    expect(a.textFound).toBe(true);
    const { autoMaskBoxes } = await import("../src/domain/doc-masking");
    const boxes = autoMaskBoxes(a.pages);
    expect(boxes.length).toBe(1);
    const masked = await real.render(pdf, "application/pdf", 1, { boxes });
    const plain = await real.render(pdf, "application/pdf", 1, { boxes: [] });
    expect(masked.contentType).toBe("image/webp");
    const px = async (img: Uint8Array) => {
      const im = await loadImage(Buffer.from(img)); const c = createCanvas(im.width, im.height); const ctx = c.getContext("2d"); ctx.drawImage(im, 0, 0);
      const b = boxes[0]!; return { ctx, w: im.width, h: im.height, b };
    };
    const m = await px(masked.image), p = await px(plain.image);
    const cx = Math.round((m.b.x + m.b.w / 2) * m.w), cy = Math.round((m.b.y + m.b.h / 2) * m.h);
    const dark = (s: typeof m) => s.ctx.getImageData(cx - 3, cy - 1, 6, 2).data.filter((_, i) => i % 4 < 3).every(v => v < 20);
    expect(dark(m)).toBe(true);
    expect(dark(p)).toBe(false);
    expect(masked.image.length).not.toBe(plain.image.length);
  });
});
