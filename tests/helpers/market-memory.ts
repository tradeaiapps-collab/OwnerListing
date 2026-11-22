import { createInMemoryAssignmentRepository } from "../../src/domain/assignment-service";
import { buildStats, type MarketCard, type Trade } from "../../src/domain/contractor-market";
import type { JobDetail, JobNotify, MarketStore, ServiceRow } from "../../src/domain/job-board";
import type { Jurisdiction } from "../../src/domain/jurisdiction";
import type { Kind } from "../../src/domain/notifications";

export const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const LISTING = U(500);
export interface Seed { cards?: MarketCard[]; services?: (ServiceRow & { userId: string })[] }

/** Whole job board in memory: assignments from the real in-memory repository, extra job fields beside them. */
export function memoryMarket(seed: Seed = {}) {
  const assignments = createInMemoryAssignmentRepository({
    listings: [{ id: LISTING, ownerUserId: U(1), jurisdiction: "QLD" as Jurisdiction, title: "12 Smith St, Paddington" }],
    users: [
      { id: U(1), userType: "owner", status: "active", displayName: "Olive Owner", email: "olive@example.com" },
      { id: U(2), userType: "vendor", status: "active", displayName: "Pat Photo", email: "pat@example.com" },
      { id: U(3), userType: "vendor", status: "active", displayName: "Ian Inspect", email: "ian@example.com" }
    ]
  });
  const extra = new Map<string, Partial<JobDetail>>(), reviews = new Map<string, { rating: number; body: string }>(), times = new Map<string, string>();
  const cards = seed.cards ?? [];
  const build = (id: string): JobDetail | undefined => {
    const a = assignments.assignments.find(x => x.id === id);
    if (!a) return undefined;
    const e = extra.get(id) ?? {};
    return { ...a, jobNumber: a.jobNumber ?? 5001, listingTitle: "12 Smith St", address: "12 Smith St, Paddington QLD 4064", ownerName: "Olive Owner", contractorName: a.contractorUserId === U(2) ? "Pat Photo" : "Ian Inspect", createdAt: "2026-11-20T00:00:00.000Z", ...e, ...(reviews.has(id) ? { review: reviews.get(id)! } : {}), ...(times.has(id) ? { proposedTime: times.get(id)! } : {}) } as JobDetail;
  };
  const store: MarketStore = {
    async cards(trade: Trade) { return cards.filter(c => c.trade === trade); },
    async card(userId, trade) { return cards.find(c => c.userId === userId && c.trade === trade); },
    async contractorByNumber(no) { const c = cards.find(x => x.contractorNo === no); return c ? { userId: c.userId } : undefined; },
    async service(userId, serviceId) { return seed.services?.find(s => s.userId === userId && s.id === serviceId); },
    async listingArea(id) { return id === LISTING ? { ownerUserId: U(1), title: "12 Smith St", address: "12 Smith St, Paddington QLD 4064", suburb: "Paddington", postcode: "4064" } : undefined; },
    async getJob(id) {
      const j = build(id), a = assignments.assignments.find(x => x.id === id);
      if (j && a && a.status === "cancelled" && !extra.get(id)?.completedAt && true) return j;
      return j;
    },
    async listJobs(userId) { return assignments.assignments.filter(a => a.ownerUserId === userId || a.contractorUserId === userId).map(a => build(a.id)!); },
    async stats() { return buildStats({ received: 0, accepted: 0, rejected: 0, completed: 0, pending: 0, thisMonth: 0, avgResponseMinutes: null }, { avg: null, count: 0 }); },
    async setDeclineReason(id, _c, reason) { extra.set(id, { ...extra.get(id), declineReason: reason }); },
    async proposeTime(id, c, iso) { const a = assignments.assignments.find(x => x.id === id); if (!a || a.contractorUserId !== c || (a.status !== "proposed" && a.status !== "approved")) return false; times.set(id, iso); return true; },
    async acceptTime(id, o) { const a = assignments.assignments.find(x => x.id === id); const t = times.get(id); if (!a || a.ownerUserId !== o || !t) return false; extra.set(id, { ...extra.get(id), scheduledTime: t }); times.delete(id); if (a.status === "proposed") a.status = "approved"; return true; },
    async rejectTime(id, o) { const a = assignments.assignments.find(x => x.id === id); if (!a || a.ownerUserId !== o || !times.has(id)) return false; times.delete(id); return true; },
    async markDone(id, c) { const a = assignments.assignments.find(x => x.id === id); if (!a || a.contractorUserId !== c || a.status !== "approved" || extra.get(id)?.contractorDoneAt) return false; extra.set(id, { ...extra.get(id), contractorDoneAt: "2026-11-21T00:00:00.000Z" }); return true; },
    async addReview(id, o, rating, body) { const a = assignments.assignments.find(x => x.id === id); if (!a || a.ownerUserId !== o || a.status !== "completed" || reviews.has(id)) return false; reviews.set(id, { rating, body }); return true; }
  };
  const sent: { to: string; kind: Kind; job: string; extra?: Record<string, string> }[] = [];
  const notify: JobNotify = async (to, kind, job, x) => { sent.push({ to, kind, job: `JOB-${job.jobNumber}`, ...(x ? { extra: x } : {}) }); };
  let n = 0;
  const ids = { newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`, now: () => "2026-11-20T00:00:00.000Z" };
  return { assignments, store, notify, sent, ids, deps: { assignments, store, ids, notify } };
}
export const card = (n: number, over: Partial<MarketCard> = {}): MarketCard => ({
  userId: U(n), contractorNo: 2000 + n - 1, name: n === 2 ? "Pat Photo" : "Ian Inspect", trade: "photographer", tradeLabel: "", headline: "", suburbs: ["Paddington"], postcodes: ["4064"],
  acceptingNew: true, openJobs: 0, fromPriceCents: 18000, ratingAvg: null, ratingCount: 0, licenceVerified: false, completed: 0, ...over
});
