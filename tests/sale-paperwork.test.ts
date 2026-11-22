import { describe, expect, it } from "vitest";
import {
  CHASE, PAPERWORK_NOTE, buildChecklist, chaseItems, checkReminder, draftReminder, nextChaseStep, summarise, type PaperFacts
} from "../src/domain/sale-paperwork";

const facts = (o: Partial<PaperFacts> = {}): PaperFacts => ({
  listingPublished: true, requiredDisclosures: ["qld_form_2", "smoke_alarm_compliance"], disclosures: [{ key: "qld_form_2", satisfied: true }],
  trustAccountApproved: true, contractFileUploaded: false, buildingReport: false, pestReport: false, ...o
});
const sale = (items: NonNullable<PaperFacts["sale"]>["items"] = []): NonNullable<PaperFacts["sale"]> => ({ settlementId: "s1", buyerIdVerified: false, items });
const by = (items: ReturnType<typeof buildChecklist>, key: string) => items.find(i => i.key === key)!;

describe("sale paperwork checklist", () => {
  it("takes disclosures from what compliance configured, not from a list of its own", () => {
    const items = buildChecklist(facts());
    expect(by(items, "disclosure:qld_form_2")).toMatchObject({ status: "done", label: "Form 2 seller disclosure (QLD)" });
    expect(by(items, "disclosure:smoke_alarm_compliance")).toMatchObject({ status: "open", party: "owner", blocks: "settlement" });
    expect(items.filter(i => i.group === "Disclosures")).toHaveLength(2);
  });
  it("says so when compliance has not configured the state yet, instead of guessing", () => {
    const i = buildChecklist(facts({ requiredDisclosures: null }));
    expect(i.filter(x => x.group === "Disclosures")).toEqual([expect.objectContaining({ key: "disclosures-config", party: "staff", status: "open" })]);
  });
  it("an unpublished listing's gate items block publishing; a published one's block settlement", () => {
    expect(by(buildChecklist(facts({ listingPublished: false, trustAccountApproved: false })), "trust-account").blocks).toBe("publish");
    expect(by(buildChecklist(facts({ trustAccountApproved: false })), "trust-account").blocks).toBe("settlement");
  });
  it("reads the contract from the signing document or an uploaded contract", () => {
    expect(by(buildChecklist(facts()), "contract-of-sale")).toMatchObject({ status: "open", blocks: "settlement" });
    expect(by(buildChecklist(facts({ contractSigning: "draft" })), "contract-of-sale").status).toBe("in_progress");
    expect(by(buildChecklist(facts({ contractSigning: "out_for_signature" })), "contract-of-sale").detail).toMatch(/signature/);
    expect(by(buildChecklist(facts({ contractSigning: "completed" })), "contract-of-sale").status).toBe("done");
    expect(by(buildChecklist(facts({ contractFileUploaded: true })), "contract-of-sale").status).toBe("done");
  });
  it("inspection reports are recommended and never block", () => {
    const items = buildChecklist(facts());
    expect(by(items, "building-report")).toMatchObject({ status: "open", blocks: "none" });
    expect(by(items, "pest-report").blocks).toBe("none");
  });
  it("brings in the settlement tracker's own checklist, later stages marked upcoming, with the person who owes each step", () => {
    const items = buildChecklist(facts({ sale: sale([
      { stage: "deposit_received", role: "buyer", itemId: "buyer-0", label: "Arrange the deposit", done: false, upcoming: false },
      { stage: "finance_approval", role: "agent", itemId: "agent-0", label: "Share the approval with the seller", done: false, upcoming: true },
      { stage: "lawyer_exchange", role: "lawyer", itemId: "lawyer-0", label: "Solicitors confirm contracts are ready", done: true, upcoming: true }
    ]) }));
    const s = items.filter(i => i.group === "Settlement steps");
    expect(s.map(i => [i.party, i.status])).toEqual([["buyer", "open"], ["agent", "upcoming"], ["owner", "done"]]);
    expect(s[0]!.label).toBe("Arrange the deposit (Deposit received)");
  });
});

describe("paperwork summary", () => {
  it("counts blockers, keeps later steps and recommendations apart, and is only ready with a sale and nothing left", () => {
    const items = buildChecklist(facts({ sale: sale([{ stage: "lawyer_exchange", role: "lawyer", itemId: "l0", label: "Sign off", done: false, upcoming: true }]) }));
    const s = summarise(items, true);
    expect(s.blockers.map(i => i.key)).toEqual(expect.arrayContaining(["disclosure:smoke_alarm_compliance", "contract-of-sale"]));
    expect(s.later).toHaveLength(1);
    expect(s.recommended.map(i => i.key)).toEqual(expect.arrayContaining(["building-report", "pest-report"]));
    expect(s.readyForSettlement).toBe(false);
    expect(s.headline).toMatch(/2 items block settlement/);
    const clean = summarise(buildChecklist(facts({ disclosures: [{ key: "qld_form_2", satisfied: true }, { key: "smoke_alarm_compliance", satisfied: true }], contractFileUploaded: true, sale: sale() })), true);
    expect(clean.readyForSettlement).toBe(true);
    expect(clean.headline).toBe("Nothing is blocking settlement.");
    expect(summarise(buildChecklist(facts({ contractFileUploaded: true, disclosures: [{ key: "qld_form_2", satisfied: true }, { key: "smoke_alarm_compliance", satisfied: true }] })), false).readyForSettlement).toBe(false);
  });
});

describe("chasing rules", () => {
  const items = buildChecklist(facts({ sale: sale([
    { stage: "deposit_received", role: "buyer", itemId: "b0", label: "Arrange the deposit", done: false, upcoming: false },
    { stage: "settlement_completed", role: "buyer", itemId: "b1", label: "Final walkthrough", done: false, upcoming: true }
  ]) }));
  it("chases only blocking, current items on that person's own side, and only during a sale", () => {
    expect(chaseItems(items, "buyer", true).map(i => i.label)).toEqual(["Arrange the deposit (Deposit received)"]);
    expect(chaseItems(items, "owner", true).map(i => i.key)).toEqual(expect.arrayContaining(["disclosure:smoke_alarm_compliance", "contract-of-sale"]));
    expect(chaseItems(items, "owner", true).some(i => i.blocks === "none")).toBe(false);
    expect(chaseItems(items, "owner", false)).toEqual([]);
  });
  const row = (reminders: number, next = "2026-11-20T00:00:00.000Z") => ({ state: "active" as const, reminders, nextActionAt: next });
  it("waits until due, sends, then stops after the third reminder", () => {
    expect(nextChaseStep(row(0), 2, "2026-11-19T23:00:00.000Z")).toEqual({ kind: "wait" });
    expect(nextChaseStep(row(0), 2, "2026-11-20T00:00:00.000Z")).toEqual({ kind: "send", reminderNo: 1 });
    expect(nextChaseStep(row(2), 2, "2026-11-21T00:00:00.000Z")).toEqual({ kind: "send", reminderNo: 3 });
    expect(nextChaseStep(row(CHASE.maxReminders), 2, "2026-11-21T00:00:00.000Z")).toEqual({ kind: "stop" });
  });
  it("finishes the moment nothing is open, and never sends for a run that is done or stopped", () => {
    expect(nextChaseStep(row(1), 0, "2026-11-21T00:00:00.000Z")).toEqual({ kind: "done" });
    expect(nextChaseStep({ ...row(1), state: "done" }, 2, "2026-11-21T00:00:00.000Z")).toEqual({ kind: "wait" });
    expect(nextChaseStep({ ...row(3), state: "stopped" }, 2, "2026-11-21T00:00:00.000Z")).toEqual({ kind: "wait" });
    expect(nextChaseStep(undefined, 0, "2026-11-21T00:00:00.000Z")).toEqual({ kind: "wait" });
  });
});

describe("reminder wording", () => {
  const d = draftReminder({ to: "Dana Smith", address: "12 Reef St, Newtown", labels: ["Contract of sale", "Smoke alarm compliance"], reminderNo: 1, party: "owner" });
  it("is fixed wording that passes the outbound check: no amounts, no contact details, says it is not legal advice", () => {
    expect(checkReminder(d)).toEqual({ ok: true });
    expect(d.body).toMatch(/^Hi Dana,/);
    expect(d.body).toContain("• Contract of sale");
    expect(d.body).toContain(PAPERWORK_NOTE);
    expect(d.body).not.toMatch(/\$\s?\d|@|https?:/);
  });
  it("lists at most six items and says how many more", () => {
    const long = draftReminder({ to: "x", address: "a", labels: Array.from({ length: 9 }, (_, i) => `Item ${i}`), reminderNo: 2, party: "buyer" });
    expect(long.body).toContain("…and 3 more.");
    expect(long.title).toMatch(/Reminder/);
  });
  it("a label that sneaks in contact details is blocked, not sent", () => {
    expect(checkReminder(draftReminder({ to: "x", address: "a", labels: ["Email me at bob@example.com"], reminderNo: 1, party: "owner" })).ok).toBe(false);
  });
});
