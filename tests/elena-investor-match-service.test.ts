import { beforeEach, describe, expect, it } from "vitest";
import { INVESTMENT_DISCLOSURE } from "../src/config/investment-disclosure";
import type { AuditEvent } from "../src/domain/audit";
import { answerElena, createInMemoryProfileStore, getElenaMatch, resetElena } from "../src/domain/elena-investor-match-service";
import { createInMemoryInvestmentRepository, createProject, decideProject, type InvestmentDeps } from "../src/domain/investment-service";
import { DEFAULT_POSTING } from "../src/domain/investment-terms";
import { moduleState, type InvestorCategory } from "../src/domain/investor-projects";
import type { Actor } from "../src/domain/listing-service";
import type { StaffActor } from "../src/domain/staff-access";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: Actor = { userId: U(1), userType: "owner" };
const wholesale: Actor = { userId: U(2), userType: "buyer" };
const retail: Actor = { userId: U(3), userType: "buyer" };
const unverified: Actor = { userId: U(4), userType: "buyer" };
const undeclared: Actor = { userId: U(5), userType: "buyer" };
const admin: StaffActor = { id: U(90), role: "super_admin" };
const base = {
  title: "Riverside townhouses", location: "Bulimba", jurisdiction: "QLD", projectType: "residential_development", stage: "approved",
  summary: "Six townhouses on a 1,200 square metre lot close to the river.", fundingTargetCents: 250_000_000, minimumTicketCents: 5_000_000,
  timeline: "DA approved; build 18 months.", risks: "Planning, construction cost and sales risk. You can lose money.", structureDescription: "Unit trust with a corporate trustee.",
  issuerName: "Riverside Dev Pty Ltd", issuerLicenceBasis: "Wholesale-only offer under s708", issuerStatement: "", issuerAuthorisedConfirmed: true, visibleTo: "all_verified"
};

let deps: InvestmentDeps, mem: ReturnType<typeof createInMemoryInvestmentRepository>, store: ReturnType<typeof createInMemoryProfileStore>, audit: AuditEvent[];
let hits = 1, n = 0;

beforeEach(async () => {
  n = 0; hits = 1; audit = []; store = createInMemoryProfileStore(); mem = createInMemoryInvestmentRepository();
  const storage = { configured: true, async put() {}, async get() { return new Uint8Array(); } };
  deps = {
    repo: mem.repo, moduleState: async () => moduleState(true, true), postingSettings: async () => ({ ...DEFAULT_POSTING }),
    verification: async u => ({ emailVerified: true, phoneVerified: u !== unverified.userId, idVerified: true }), countHit: async () => hits, contactFor: async () => undefined,
    notify: async () => {}, files: { storage, scanner: { configured: true, async scan() { return "clean" as const; } } },
    startUpfrontCheckout: async () => { throw new Error("no"); }, sha256: async () => "a".repeat(64), appUrl: "http://test",
    appendAudit: async e => { audit.push(e); }, now: () => "2026-11-21T00:00:00.000Z", newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`
  };
  const decl = (a: Actor, category: InvestorCategory, i: number) => mem.repo.addDeclaration({ id: U(i), userId: a.userId, category, disclosureVersion: INVESTMENT_DISCLOSURE.version, declaredAt: deps.now() });
  await decl(wholesale, "wholesale", 200); await decl(retail, "retail", 201); await decl(unverified, "retail", 202);
});

async function post(o: Record<string, unknown> = {}, approve = true) {
  const r = await createProject(deps, owner, { ...base, ...o });
  if (!r.ok) throw new Error(r.message);
  const p = (await mem.repo.getProject(r.value.project.id))!;
  if (approve) expect((await decideProject(deps, admin, p.id, "approve", "Checked issuer and risks.", p.version)).ok).toBe(true);
  return p.id;
}
const A = [
  { step: "budget", value: { budgetMaxCents: 10_000_000 } }, { step: "risk", value: { risk: "balanced" } },
  { step: "location", value: { jurisdictions: ["QLD"], suburbs: [] } }, { step: "timeframe", value: { timeframe: "2_4y" } }
];
async function run(who: Actor) { let last; for (const a of A) { last = await answerElena(deps, store, who, a); if (!last.ok) return last; } return last!; }

describe("Elena investor onboarding service", () => {
  it("walks the questions, stores the answers, and then lists matches with reasons", async () => {
    const id = await post();
    const first = await getElenaMatch(deps, store, wholesale);
    expect(first.ok && first.value.next?.step).toBe("budget");
    const r = await run(wholesale);
    expect(r.ok && r.value.next).toBeNull();
    if (!r.ok) throw new Error(r.message);
    expect(r.value.results!.cards.map(c => c.project.id)).toEqual([id]);
    expect(r.value.results!.cards[0]!.match.reasons.length).toBeGreaterThan(2);
    expect(r.value.notice).toMatch(/not financial, legal or tax advice/);
    const again = await getElenaMatch(deps, store, wholesale);
    expect(again.ok && again.value.results?.cards).toHaveLength(1);
    expect(audit.filter(e => e.eventType === "investment.elena_preferences_saved")).toHaveLength(4);
    expect((audit.at(-1)!.payload as { matchedProjectIds: string[] }).matchedProjectIds).toEqual([id]);
  });
  it("only ever matches projects the investor may already browse: approved, visible to their category, not their own", async () => {
    await post({ title: "Wholesale only", visibleTo: "wholesale_only" });
    await post({ title: "Still pending" }, false);
    const open = await post({ title: "Open to all" });
    const w = await run(wholesale);
    expect(w.ok && w.value.results!.cards).toHaveLength(2);
    store.rows.clear();
    const r = await run(retail);
    expect(r.ok && r.value.results!.cards.map(c => c.project.id)).toEqual([open]);
  });
  it("gives the same step a person would see elsewhere when the investor is not ready, and stores nothing", async () => {
    for (const who of [unverified, undeclared, owner, { userId: U(77), userType: "buyer" } as Actor]) {
      const r = await answerElena(deps, store, who, A[0]);
      expect(r.ok).toBe(false);
    }
    expect(store.rows.size).toBe(0);
    const u = await answerElena(deps, store, unverified, A[0]);
    expect(!u.ok && u.message).toMatch(/mobile/i);
  });
  it("rejects bad answers without saving, and rate limits fail closed", async () => {
    const bad = await answerElena(deps, store, wholesale, { step: "budget", value: { budgetMaxCents: 1 } });
    expect(!bad.ok && bad.code).toBe("invalid");
    expect(store.rows.size).toBe(0);
    hits = 9999;
    const slow = await answerElena(deps, store, wholesale, A[0]);
    expect(!slow.ok && slow.code).toBe("rate_limited");
    deps.countHit = async () => { throw new Error("down"); };
    const down = await answerElena(deps, store, wholesale, A[0]);
    expect(!down.ok && down.code).toBe("rate_limited");
  });
  it("lets the investor change an answer and delete their preferences, keeping an audit trail", async () => {
    await post();
    await run(wholesale);
    const changed = await answerElena(deps, store, wholesale, { step: "budget", value: { budgetMaxCents: 1_000_000 } });
    expect(changed.ok && changed.value.results!.cards).toHaveLength(0);
    expect(changed.ok && changed.value.results!.excluded.budget).toBe(1);
    const cleared = await resetElena(deps, store, wholesale);
    expect(cleared.ok).toBe(true);
    expect(store.rows.size).toBe(0);
    expect(audit.at(-1)!.eventType).toBe("investment.elena_preferences_cleared");
    const fresh = await getElenaMatch(deps, store, wholesale);
    expect(fresh.ok && fresh.value.next?.step).toBe("budget");
  });
  it("keeps one investor's answers away from another", async () => {
    await run(wholesale);
    const r = await getElenaMatch(deps, store, retail);
    expect(r.ok && r.value.next?.step).toBe("budget");
  });
});
