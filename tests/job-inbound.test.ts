import { describe, expect, it } from "vitest";
import { actOnJob, bookContractor } from "../src/domain/job-board";
import { processJobEmail, type InboundJobDeps } from "../src/domain/job-inbound";
import { LISTING, U, card, memoryMarket } from "./helpers/market-memory";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
async function jobReady(accept = true) {
  const m = memoryMarket({ cards: [card(2)] });
  const b = await bookContractor(m.deps, { userId: U(1), userType: "owner" }, LISTING, { kind: "photographer", contractorNo: 2001 });
  if (!b.ok) throw new Error("setup");
  if (accept) await actOnJob(m.deps, { userId: U(2), userType: "vendor" }, b.value.id, { action: "accept" });
  const uploads: string[] = [], told: number[] = [];
  const deps: InboundJobDeps = {
    sniff: b => (b[0] === 0xff ? "image/jpeg" : b[0] === 0x25 ? "application/pdf" : undefined),
    async findJob(no, email) { const j = await m.store.getJob(b.value.id); return j && j.jobNumber === no && email === "pat@example.com" ? j : undefined; },
    async upload(_j, kind) { uploads.push(kind); return { ok: true, value: { id: "d" } }; },
    async notifyOwner(_j, n) { told.push(n); }
  };
  return { deps, uploads, told };
}
const mail = (over: object = {}) => ({ from: "pat@example.com", subject: "Re: JOB-5001 photos", text: "", files: [{ filename: "kitchen.jpg", contentType: "image/jpeg", bytes: JPEG }], ...over });

describe("processJobEmail", () => {
  it("attaches files to the job named in the subject and tells the owner once", async () => {
    const { deps, uploads, told } = await jobReady();
    const r = await processJobEmail(deps, mail({ files: [mail().files[0], mail().files[0]] }));
    expect(r).toMatchObject({ matched: true, jobNumber: 5001, accepted: 2 });
    expect(uploads).toEqual(["photo", "photo"]);
    expect(told).toEqual([2]);
  });
  it("finds the number in the body when the subject has none", async () => {
    const { deps } = await jobReady();
    expect((await processJobEmail(deps, mail({ subject: "photos", text: "Here you go, JOB-5001" }))).matched).toBe(true);
  });
  it("gives one answer for a wrong number and a wrong sender, and attaches nothing", async () => {
    const { deps, uploads } = await jobReady();
    const wrongNo = await processJobEmail(deps, mail({ subject: "JOB-5999" }));
    const wrongFrom = await processJobEmail(deps, mail({ from: "mallory@example.com" }));
    expect(wrongNo.matched).toBe(false); expect(wrongFrom.matched).toBe(false);
    expect(wrongNo.reply.replace("5999", "5001")).toBe(wrongFrom.reply);
    expect(uploads).toEqual([]);
  });
  it("asks for a number, refuses jobs that are not accepted, and reports files it cannot take", async () => {
    const none = await jobReady();
    expect((await processJobEmail(none.deps, mail({ subject: "photos" }))).reply).toContain("job number");
    const waiting = await jobReady(false);
    expect(await processJobEmail(waiting.deps, mail())).toMatchObject({ matched: true, accepted: 0 });
    expect(waiting.uploads).toEqual([]);
    const { deps, told } = await jobReady();
    const r = await processJobEmail(deps, mail({ files: [{ filename: "virus.exe", contentType: "application/octet-stream", bytes: new Uint8Array([0x4d, 0x5a]) }, mail().files[0]] }));
    expect(r.accepted).toBe(1);
    expect(r.rejected).toEqual([{ filename: "virus.exe", reason: "This file type is not accepted for this job." }]);
    expect(told).toEqual([1]);
  });
  it("tells the sender when the upload service refuses a file, and does not notify for nothing", async () => {
    const { deps, told } = await jobReady();
    deps.upload = async () => ({ ok: false, code: "invalid", message: "The file did not pass the security scan." });
    const r = await processJobEmail(deps, mail());
    expect(r.accepted).toBe(0);
    expect(r.reply).toContain("did not pass the security scan");
    expect(told).toEqual([]);
  });
});
