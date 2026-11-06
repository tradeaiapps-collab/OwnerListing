import { beforeEach, describe, expect, it } from "vitest";
import { noVariants } from "../src/adapters/image-variants";
import { INVESTMENT_DISCLOSURE } from "../src/config/investment-disclosure";
import type { AuditEvent } from "../src/domain/audit";
import { createInMemoryInvestmentRepository, createProject, decideProject, type InvestmentDeps } from "../src/domain/investment-service";
import { DEFAULT_POSTING } from "../src/domain/investment-terms";
import { moduleState } from "../src/domain/investor-projects";
import { photoUrl, srcSetFor } from "../src/domain/listing-photos";
import type { Actor } from "../src/domain/listing-service";
import type { PhotoPorts } from "../src/domain/photo-service";
import {
  createInMemoryProjectPhotoStore, listProjectPhotos, onlyHides, PROJECT_PHOTO_MAX, readProjectPhoto, updateProjectLayout, uploadProjectPhoto
} from "../src/domain/project-photos";
import type { StaffActor } from "../src/domain/staff-access";
import { jpeg, png } from "./helpers/image-fixtures";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: Actor = { userId: U(1), userType: "owner" };
const wholesale: Actor = { userId: U(2), userType: "buyer" };
const retail: Actor = { userId: U(3), userType: "buyer" };
const stranger: Actor = { userId: U(5), userType: "owner" };
const admin: StaffActor = { id: U(90), role: "super_admin" };
const EXE = Uint8Array.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0]);

const fields = (o: Record<string, unknown> = {}) => ({
  title: "Riverside townhouses", location: "Bulimba", jurisdiction: "QLD", projectType: "residential_development", stage: "planning",
  summary: "Six townhouses on a 1,200 square metre lot close to the river.", fundingTargetCents: 250_000_000, minimumTicketCents: 5_000_000,
  timeline: "DA lodged; build 18 months.", risks: "Planning, construction cost and sales risk. You can lose money.", structureDescription: "Unit trust with a corporate trustee.",
  issuerName: "Riverside Dev Pty Ltd", issuerLicenceBasis: "Wholesale-only offer under s708", issuerStatement: "", issuerAuthorisedConfirmed: true, visibleTo: "all_verified", ...o
});

let deps: InvestmentDeps;
let mem: ReturnType<typeof createInMemoryInvestmentRepository>;
let photos: ReturnType<typeof createInMemoryProjectPhotoStore>;
let objects: Map<string, Uint8Array>;
let ports: PhotoPorts;
let verdict: "clean" | "infected";
let audit: AuditEvent[];
let n = 0;

beforeEach(async () => {
  n = 0; verdict = "clean"; audit = []; objects = new Map();
  mem = createInMemoryInvestmentRepository();
  photos = createInMemoryProjectPhotoStore();
  ports = {
    storage: { configured: true, async put(k, b) { objects.set(k, b); }, async get(k) { const b = objects.get(k); if (!b) throw new Error("missing"); return b; } },
    scanner: { configured: true, async scan() { return verdict; } },
    variants: noVariants
  };
  deps = {
    repo: mem.repo,
    moduleState: async () => moduleState(true, true),
    postingSettings: async () => ({ ...DEFAULT_POSTING }),
    verification: async () => ({ emailVerified: true, phoneVerified: true, idVerified: true }),
    countHit: async () => 1,
    contactFor: async () => undefined,
    notify: async () => {},
    files: { storage: ports.storage, scanner: ports.scanner },
    startUpfrontCheckout: async () => { throw new Error("not connected"); },
    sha256: async () => "a".repeat(64),
    appUrl: "http://test",
    appendAudit: async e => { audit.push(e); },
    now: () => "2026-10-28T00:00:00.000Z",
    newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`
  };
  await mem.repo.addDeclaration({ id: U(200), userId: wholesale.userId, category: "wholesale", disclosureVersion: INVESTMENT_DISCLOSURE.version, declaredAt: "2026-10-28T00:00:00.000Z" });
  await mem.repo.addDeclaration({ id: U(201), userId: retail.userId, category: "retail", disclosureVersion: INVESTMENT_DISCLOSURE.version, declaredAt: "2026-10-28T00:00:00.000Z" });
});

async function posted(o: Record<string, unknown> = {}) {
  const r = await createProject(deps, owner, fields(o));
  if (!r.ok) throw new Error(r.message);
  return r.value.project.id;
}
async function approve(id: string) {
  const p = (await mem.repo.getProject(id))!;
  const r = await decideProject(deps, admin, id, "approve", "Checked issuer and risks.", p.version);
  expect(r.ok).toBe(true);
}
const upload = (id: string, bytes: Uint8Array = jpeg(), mime = "image/jpeg", extra: { replacesId?: string } = {}) =>
  uploadProjectPhoto(deps, photos.store, ports, owner, id, { declaredMime: mime, bytes, ...extra });
const status = async (id: string) => (await mem.repo.getProject(id))!.status;

describe("project photo upload", () => {
  it("stores a stripped JPEG under a random key and adds it to the end of the gallery", async () => {
    const id = await posted();
    const a = await upload(id), b = await upload(id, png(), "image/png");
    expect(a.ok && b.ok).toBe(true);
    expect(photos.layouts.at(-1)!.entries.map(e => e.photoId)).toEqual([a.ok && a.value.id, b.ok && b.value.id]);
    const key = [...objects.keys()][0]!;
    // Three segments: the storage adapters accept no deeper keys.
    expect(key).toMatch(new RegExp(`^investments/${id}/[0-9a-f-]{36}$`));
    expect(Buffer.from(objects.get(key)!).includes(Buffer.from("GPS-LAT"))).toBe(false);
    expect(audit.some(e => e.eventType === "investment.project_photo_uploaded")).toBe(true);
  });

  it("only the owner may upload; a rejected project is closed", async () => {
    const id = await posted();
    const r = await uploadProjectPhoto(deps, photos.store, ports, stranger, id, { declaredMime: "image/jpeg", bytes: jpeg() });
    expect(!r.ok && r.code).toBe("not_found");
    const p = (await mem.repo.getProject(id))!;
    await decideProject(deps, admin, id, "reject", "Not a real project offer.", p.version);
    const closed = await upload(id);
    expect(!closed.ok && closed.code).toBe("conflict");
  });

  it("refuses wrong types, disguised files, infected files and unconfigured storage", async () => {
    const id = await posted();
    expect((await upload(id, EXE, "image/jpeg")).ok).toBe(false);
    expect((await upload(id, jpeg(), "image/png")).ok).toBe(false);
    expect((await upload(id, jpeg(), "application/pdf")).ok).toBe(false);
    verdict = "infected";
    const bad = await upload(id);
    expect(!bad.ok && bad.message).toMatch(/security scan/);
    verdict = "clean";
    ports = { ...ports, scanner: { configured: false, async scan() { return "clean" as const; } } };
    const off = await upload(id);
    expect(!off.ok && off.code).toBe("unavailable");
    expect(objects.size).toBe(0);
  });

  it(`caps showing photos at ${PROJECT_PHOTO_MAX}`, async () => {
    const id = await posted();
    for (let i = 0; i < PROJECT_PHOTO_MAX; i++) expect((await upload(id)).ok).toBe(true);
    const r = await upload(id);
    expect(!r.ok && r.message).toMatch(new RegExp(`up to ${PROJECT_PHOTO_MAX}`));
  });

  it("an upload to an approved project sends it back to staff review", async () => {
    const id = await posted();
    await approve(id);
    expect(await status(id)).toBe("approved");
    expect((await upload(id)).ok).toBe(true);
    expect(await status(id)).toBe("pending_review");
  });

  it("a replacement takes the old photo's place and keeps it on record, hidden", async () => {
    const id = await posted();
    const a = await upload(id);
    const old = a.ok ? a.value.id : "";
    const b = await upload(id, jpeg(), "image/jpeg", { replacesId: old });
    expect(b.ok).toBe(true);
    const entries = photos.layouts.at(-1)!.entries;
    expect(entries.map(e => [e.photoId, e.hidden])).toEqual([[b.ok && b.value.id, false], [old, true]]);
  });
});

describe("project gallery access", () => {
  async function withPhotos(o: Record<string, unknown> = {}) {
    const id = await posted(o);
    const a = await upload(id), b = await upload(id);
    const ids = [a.ok ? a.value.id : "", b.ok ? b.value.id : ""];
    // Owner hides the second photo.
    const r = await updateProjectLayout(deps, photos.store, owner, id, { version: 2, entries: [{ photoId: ids[0], caption: "Street view", alt: "", hidden: false }, { photoId: ids[1], caption: "", alt: "", hidden: true }] });
    expect(r.ok).toBe(true);
    return { id, ids };
  }

  it("refuses swearing in a project photo caption unless the owner posts it anyway", async () => {
    const { id, ids } = await withPhotos();
    const entries = [{ photoId: ids[0], caption: "fuck", alt: "", hidden: false }, { photoId: ids[1], caption: "", alt: "", hidden: true }];
    const blocked = await updateProjectLayout(deps, photos.store, owner, id, { version: 3, entries });
    expect(blocked.ok).toBe(false);
    const allowed = await updateProjectLayout(deps, photos.store, owner, id, { version: 3, entries, allowFlagged: true });
    expect(allowed.ok).toBe(true);
  });

  it("the owner and staff see every photo; nobody else sees a project in review", async () => {
    const { id } = await withPhotos();
    const mine = await listProjectPhotos(deps, photos.store, owner, id);
    expect(mine.ok && mine.value.photos.length).toBe(2);
    expect(mine.ok && mine.value.canManage).toBe(true);
    const staff = await listProjectPhotos(deps, photos.store, null, id, { staffId: admin.id });
    expect(staff.ok && staff.value.photos.length).toBe(2);
    expect(staff.ok && staff.value.canManage).toBe(false);
    expect((await listProjectPhotos(deps, photos.store, wholesale, id)).ok).toBe(false);
    expect((await listProjectPhotos(deps, photos.store, null, id)).ok).toBe(false);
  });

  it("an allowed investor sees only showing photos of an approved project; a disallowed one sees nothing", async () => {
    const { id, ids } = await withPhotos({ visibleTo: "wholesale_only" });
    await approve(id);
    const inv = await listProjectPhotos(deps, photos.store, wholesale, id);
    expect(inv.ok && inv.value.photos.map(p => [p.id, p.caption])).toEqual([[ids[0], "Street view"]]);
    expect((await listProjectPhotos(deps, photos.store, retail, id)).ok).toBe(false);
    expect((await listProjectPhotos(deps, photos.store, stranger, id)).ok).toBe(false);
  });

  it("photo bytes follow the same rules; staff views are audited", async () => {
    const { id, ids } = await withPhotos();
    await approve(id);
    const storage = ports.storage;
    expect((await readProjectPhoto(deps, photos.store, storage, wholesale, ids[0]!, "full")).ok).toBe(true);
    expect((await readProjectPhoto(deps, photos.store, storage, wholesale, ids[1]!, "full")).ok).toBe(false);
    expect((await readProjectPhoto(deps, photos.store, storage, null, ids[0]!, "full")).ok).toBe(false);
    expect((await readProjectPhoto(deps, photos.store, storage, owner, ids[1]!, "thumb")).ok).toBe(true);
    audit = [];
    expect((await readProjectPhoto(deps, photos.store, storage, null, ids[1]!, "full", { staffId: admin.id })).ok).toBe(true);
    expect(audit.map(e => e.eventType)).toEqual(["investment.project_photo_viewed_by_staff"]);
  });
});

describe("project gallery layout", () => {
  it("never drops a photo, refuses a stale version, and only hiding skips review", async () => {
    const id = await posted();
    const a = await upload(id), b = await upload(id);
    const [x, y] = [a.ok ? a.value.id : "", b.ok ? b.value.id : ""];
    const e = (photoId: string, o: Record<string, unknown> = {}) => ({ photoId, caption: "", alt: "", hidden: false, ...o });
    const drop = await updateProjectLayout(deps, photos.store, owner, id, { version: 2, entries: [e(x)] });
    expect(!drop.ok && drop.message).toMatch(/cannot be deleted/);
    const stale = await updateProjectLayout(deps, photos.store, owner, id, { version: 1, entries: [e(y), e(x)] });
    expect(!stale.ok && stale.code).toBe("conflict");
    await approve(id);
    const hide = await updateProjectLayout(deps, photos.store, owner, id, { version: 2, entries: [e(x), e(y, { hidden: true })] });
    expect(hide.ok && hide.value.backToReview).toBe(false);
    expect(await status(id)).toBe("approved");
    const reorder = await updateProjectLayout(deps, photos.store, owner, id, { version: 3, entries: [e(y, { hidden: true }), e(x, { caption: "Cover" })] });
    expect(reorder.ok && reorder.value.backToReview).toBe(true);
    expect(await status(id)).toBe("pending_review");
    expect((await updateProjectLayout(deps, photos.store, stranger, id, { version: 4, entries: [] })).ok).toBe(false);
  });

  it("onlyHides is true only for hide-only changes", () => {
    const a = { photoId: "a", caption: "", alt: "", hidden: false }, b = { photoId: "b", caption: "", alt: "", hidden: false };
    expect(onlyHides([a, b], [a, { ...b, hidden: true }])).toBe(true);
    expect(onlyHides([a, { ...b, hidden: true }], [a, b])).toBe(false);
    expect(onlyHides([a, b], [b, a])).toBe(false);
    expect(onlyHides([a, b], [a, { ...b, caption: "x" }])).toBe(false);
  });

  it("project photo URLs use the project routes", () => {
    expect(photoUrl("p1", "thumb", "/api/investments/photos")).toBe("/api/investments/photos/p1?size=thumb");
    expect(photoUrl("p1")).toBe("/api/photos/p1");
    expect(srcSetFor({ id: "p1", width: 2000, sizes: ["thumb", "full"] }, "/api/staff/investments/photos")).toBe("/api/staff/investments/photos/p1?size=thumb 480w, /api/staff/investments/photos/p1 2000w");
  });
});
