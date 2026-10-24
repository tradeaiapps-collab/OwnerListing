import type { MalwareScanPort } from "../../src/adapters/malware-scan";
import type { ObjectStoragePort } from "../../src/adapters/object-storage";
import { ID_CLAIM_TTL_MS, type IdImagePart } from "../../src/domain/id-image";
import type { IdImageDeps, IdImageEvent, IdImageStore, NewSubmission } from "../../src/server/id-image";

export const KEY = Buffer.alloc(32, 7).toString("base64");
export const RETENTION_SECRET = "r".repeat(40);

// ---- tiny but structurally valid images ----
const seg = (marker: number, body: number[] | Buffer) => {
  const b = Buffer.from(body as number[]);
  return Buffer.concat([Buffer.from([0xff, marker, (b.length + 2) >> 8, (b.length + 2) & 0xff]), b]);
};
export const GPS_TEXT = "GPSLatitude-27.4698";
export function jpegWithExif(): Uint8Array {
  return new Uint8Array(Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    seg(0xe1, Buffer.from(`Exif\0\0MM${GPS_TEXT}`, "latin1")),
    seg(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0<x/>", "latin1")),
    seg(0xfe, Buffer.from("comment", "latin1")),
    seg(0xdb, [0, ...new Array(64).fill(1)]),
    seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9])
  ]));
}
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
};
export function pngWithText(): Uint8Array {
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", Buffer.from([0, 0, 0, 4, 0, 0, 0, 3, 8, 2, 0, 0, 0])), chunk("tEXt", Buffer.from(`Comment\0${GPS_TEXT}`, "latin1")),
    chunk("eXIf", Buffer.from(`MM${GPS_TEXT}`, "latin1")), chunk("IDAT", Buffer.from([1, 2, 3])), chunk("IEND", Buffer.alloc(0))
  ]));
}
const riffChunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from(type, "latin1"), len, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
export function webpWithExif(): Uint8Array {
  const body = Buffer.concat([
    riffChunk("VP8X", Buffer.from([0x0c, 0, 0, 0, 1, 0, 0, 1, 0, 0])), riffChunk("VP8 ", Buffer.from([1, 2, 3, 4])),
    riffChunk("EXIF", Buffer.from(`MM${GPS_TEXT}`, "latin1")), riffChunk("XMP ", Buffer.from("<x/>"))
  ]);
  const size = Buffer.alloc(4); size.writeUInt32LE(body.length + 4);
  return new Uint8Array(Buffer.concat([Buffer.from("RIFF"), size, Buffer.from("WEBP"), body]));
}
export const HEIC = new Uint8Array(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(16)]));
export const PDF = new Uint8Array(Buffer.from("%PDF-1.7 hello"));

// ---- ports ----
export function memStorage(o: { configured?: boolean; removable?: boolean; failRemove?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>();
  const port: ObjectStoragePort = {
    configured: o.configured ?? true,
    async put(k, b) { if (objects.has(k)) throw new Error("exists"); objects.set(k, new Uint8Array(b)); },
    async get(k) { const b = objects.get(k); if (!b) throw new Error("missing"); return new Uint8Array(b); },
    ...(o.removable === false ? {} : { async remove(k: string) { if (o.failRemove) throw new Error("boom"); objects.delete(k); } })
  };
  return { port, objects };
}
export function scanner(verdict: "clean" | "infected" | "error" = "clean", configured = true): MalwareScanPort & { scanned: number } {
  const s = {
    configured, scanned: 0,
    async scan() { s.scanned++; if (verdict === "error") throw new Error("down"); return verdict; }
  };
  return s;
}

// ---- in-memory store behaving like id-image-db.ts ----
export interface MemRow extends NewSubmission {
  status: string; approvals: string[]; submittedAt: number; decidedAt: number | null;
  assignedTo: string | null; assignedAt: number | null; deletedAt: number | null;
}
export function memStore(clock: { now: number }, opts: { email?: boolean; phone?: boolean; id?: boolean; hitsOverride?: number | undefined } = {}) {
  const rows = new Map<string, MemRow>();
  const hits = new Map<string, number>();
  const log: { event: IdImageEvent; userId?: string; submissionId?: string; staffId?: string; ipHash?: string }[] = [];
  const consents: { userId: string; version: string }[] = [];
  const views: { submissionId: string; staffId: string; part: IdImagePart; stage: "view" | "shown"; at: number }[] = [];
  const st = { failView: false, useOverride: "hitsOverride" in opts };
  const store: IdImageStore = {
    async hit(b) { if (st.useOverride) return opts.hitsOverride; const n = (hits.get(b) ?? 0) + 1; hits.set(b, n); return n; },
    async buyerState(userId) {
      const mine = [...rows.values()].filter(r => r.userId === userId);
      return {
        emailVerified: opts.email ?? true, phoneVerified: opts.phone ?? true, idVerified: opts.id ?? false,
        pending: mine.some(r => r.status === "pending"),
        recentSubmittedAt: mine.filter(r => clock.now - r.submittedAt < 86_400_000).map(r => new Date(r.submittedAt).toISOString())
      };
    },
    async recordConsent(userId, version) { consents.push({ userId, version }); },
    async latestStatus(userId) { return [...rows.values()].filter(r => r.userId === userId).sort((a, b) => b.submittedAt - a.submittedAt)[0]?.status ?? null; },
    async insertSubmission(s) {
      if ([...rows.values()].some(r => r.userId === s.userId && r.status === "pending")) return false;
      rows.set(s.id, { ...s, status: "pending", approvals: [], submittedAt: clock.now, decidedAt: null, assignedTo: null, assignedAt: null, deletedAt: null });
      return true;
    },
    async log(e) { log.push(e); },
    async reviewState(id) {
      const r = rows.get(id);
      if (!r) return null;
      return {
        userId: r.userId, status: r.status, approvals: r.approvals, assignedTo: r.assignedTo,
        assignedAt: r.assignedAt === null ? null : new Date(r.assignedAt).toISOString(), deleted: r.deletedAt !== null,
        parts: (["front", "back", "selfie"] as const).filter(p => r.images[p] !== undefined)
      };
    },
    async claim(id, staffId, ttl) {
      const r = rows.get(id);
      if (!r || r.status !== "pending" || r.userId === staffId || r.approvals.includes(staffId)) return false;
      if (r.assignedTo !== null && r.assignedTo !== staffId && r.assignedAt !== null && clock.now - r.assignedAt < ttl) return false;
      r.assignedTo = staffId; r.assignedAt = clock.now;
      return true;
    },
    async image(id, part) { const r = rows.get(id); return r && r.deletedAt === null ? r.images[part] ?? null : null; },
    async recordView(submissionId, staffId, part, stage) { if (st.failView) throw new Error("db down"); views.push({ submissionId, staffId, part, stage, at: clock.now }); },
    async viewedParts(id, staffId, since) { return views.filter(v => v.submissionId === id && v.staffId === staffId && v.stage === "shown" && v.at >= Date.parse(since)).map(v => v.part); },
    async dueForDeletion(a, rj, limit) {
      return [...rows.values()].filter(r => r.deletedAt === null && r.decidedAt !== null && (
        (r.status === "approved" && r.decidedAt <= Date.parse(a)) || ((r.status === "rejected" || r.status === "needs_more") && r.decidedAt <= Date.parse(rj))
      )).slice(0, limit).map(r => ({ id: r.id, userId: r.userId, keys: Object.values(r.images).map(i => i.key) }));
    },
    async markDeleted(id) {
      const r = rows.get(id);
      if (!r || r.deletedAt !== null) return false;
      r.images = {}; r.deletedAt = clock.now; log.push({ event: "images_deleted", userId: r.userId, submissionId: id });
      return true;
    }
  };
  return { store, rows, hits, log, consents, views, st };
}

export function deps(o: { storage?: ObjectStoragePort; scanner?: MalwareScanPort; key?: string | undefined; retentionSecret?: string | undefined;
  clock?: { now: number }; store?: IdImageStore } = {}): IdImageDeps & { clock: { now: number } } {
  const clock = o.clock ?? { now: Date.parse("2026-10-25T00:00:00.000Z") };
  return {
    store: o.store ?? memStore(clock).store, storage: o.storage ?? memStorage().port, scanner: o.scanner ?? scanner(),
    key: "key" in o ? o.key : KEY, retentionSecret: "retentionSecret" in o ? o.retentionSecret : RETENTION_SECRET,
    now: () => clock.now, clock
  };
}

export const TTL = ID_CLAIM_TTL_MS;
