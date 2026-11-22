import { describe, expect, it } from "vitest";
import {
  LIMITS, checkOutbound, draftMessage, findJobNo, onAccepted, onAnswer, onDue, onProposal, onProposalElsewhere, onScheduledElsewhere, onReply, parseProposedTime, rateLimited, readReply, zonedToUtc,
  type ElenaJob, type JobSettings, type MessageVars
} from "../src/domain/elena-jobs";

const NOW = "2026-11-20T00:00:00.000Z"; // 11am Sydney
const job = (o: Partial<ElenaJob> = {}): ElenaJob => ({ id: "j1", assignmentId: "a1", listingId: "l1", kind: "photographer", contactRef: "JOB-5001", state: "negotiating", rounds: 0, reminders: 0, createdAt: NOW, ...o });
const on: JobSettings = { handleJobs: true, autoReply: false, hideNewFiles: false };
const sends = (steps: ReturnType<typeof onDue>) => steps.filter(s => s.type === "send").map(s => (s.type === "send" ? `${s.to}:${s.kind}` : ""));
const patch = (steps: ReturnType<typeof onDue>) => Object.assign({}, ...steps.filter(s => s.type === "set").map(s => (s.type === "set" ? s.patch : {})));
const vars: MessageVars = { address: "12 Smith St, Newtown", contractor: "Pat", owner: "Olive", kindLabel: "photographer", ref: "JOB-5001", when: "Tuesday 25 November, 10:30 am" };

describe("parseProposedTime", () => {
  it("reads day-first dates in the property's time zone", () => {
    expect(parseProposedTime("25/11/2026 10:30am", NOW, "NSW")).toBe("2026-11-24T23:30:00.000Z"); // AEDT +11
    expect(parseProposedTime("Tuesday 25 November at 2pm", NOW, "QLD")).toBe("2026-11-25T04:00:00.000Z"); // AEST +10
    expect(parseProposedTime("2026-12-01 14:00", NOW, "WA")).toBe("2026-12-01T06:00:00.000Z");
  });
  it("needs both a date and a time, in the future, and a real date", () => {
    expect(parseProposedTime("sometime next week", NOW, "NSW")).toBeUndefined();
    expect(parseProposedTime("25 Nov", NOW, "NSW")).toBeUndefined();
    expect(parseProposedTime("1 Nov 2026 9am", NOW, "NSW")).toBeUndefined();
    expect(parseProposedTime("31/2/2026 9am", NOW, "NSW")).toBeUndefined();
    expect(zonedToUtc(2026, 2, 31, 9, 0, "Australia/Sydney")).toBeUndefined();
  });
  it("rolls a date without a year to next year when it has passed", () => {
    expect(parseProposedTime("5 Jan 9am", "2026-12-20T00:00:00.000Z", "VIC")).toBe("2027-01-04T22:00:00.000Z");
  });
});

describe("readReply", () => {
  it("sends anything about money to the owner, even with a time in it", () => {
    expect(readReply("Yes 25 Nov 10am, it's $250 for the visit", NOW, "NSW").intent).toBe("money");
    expect(readReply("what is your fee?", NOW, "NSW").intent).toBe("money");
  });
  it("reads proposals, plain answers and questions", () => {
    expect(readReply("I can do 26 Nov 2pm", NOW, "NSW")).toMatchObject({ intent: "propose", at: "2026-11-26T03:00:00.000Z" });
    expect(readReply("Yes, that works", NOW, "NSW").intent).toBe("accept");
    expect(readReply("No, sorry I can't make it", NOW, "NSW").intent).toBe("reject");
    expect(readReply("No, 27 Nov 3pm suits me better", NOW, "NSW")).toMatchObject({ intent: "reject", at: expect.any(String) });
    expect(readReply("Is there parking?", NOW, "NSW").intent).toBe("question");
    expect(readReply("Thanks!", NOW, "NSW").intent).toBe("other");
  });
  it("does not treat a long mixed message as a plain yes", () => {
    expect(readReply("Yes but also I wanted to ask about access to the roof and whether the dog will be home", NOW, "NSW").intent).toBe("other");
  });
});

describe("time negotiation", () => {
  it("asks the contractor for a time when they accept", () => {
    const s = onAccepted(NOW);
    expect(patch(s).state).toBe("negotiating");
    expect(sends(s)).toEqual(["contractor:ask_time"]);
  });
  it("passes a proposal to the other party, then confirms both when they agree", () => {
    const p = onProposal(job(), "contractor", "2026-11-26T03:00:00.000Z", NOW);
    expect(sends(p)).toEqual(["owner:time_to_confirm"]);
    const proposed = job({ ...patch(p), state: "negotiating" });
    expect(proposed.proposedBy).toBe("contractor");
    const a = onAnswer(proposed, "owner", true, NOW);
    expect(patch(a)).toMatchObject({ state: "scheduled", appointmentAt: "2026-11-26T03:00:00.000Z" });
    expect(sends(a)).toEqual(["owner:confirmed", "contractor:confirmed"]);
  });
  it("on a rejection asks both parties for another time and keeps going", () => {
    const proposed = job({ proposedAt: "2026-11-26T03:00:00.000Z", proposedBy: "contractor", rounds: 1 });
    const r = onAnswer(proposed, "owner", false, NOW);
    expect(sends(r)).toEqual(["owner:time_rejected", "contractor:time_rejected"]);
    expect(patch(r).rounds).toBe(2);
    // the contractor (or the owner) then proposes again and the loop continues
    const next = job({ rounds: 2 });
    expect(sends(onProposal(next, "owner", "2026-11-27T03:00:00.000Z", NOW))).toEqual(["contractor:time_confirm".replace("time_confirm", "time_to_confirm")]);
  });
  it("lets only the other party answer", () => {
    const proposed = job({ proposedAt: "2026-11-26T03:00:00.000Z", proposedBy: "contractor" });
    expect(onAnswer(proposed, "contractor", true, NOW)).toEqual([]);
  });
  it("hands back to the owner after too many rounds", () => {
    const s = onProposal(job({ rounds: LIMITS.maxRounds }), "owner", "2026-11-27T03:00:00.000Z", NOW);
    expect(patch(s).state).toBe("needs_owner");
    expect(sends(s)).toEqual([]);
  });
});

describe("staying in step with the Jobs page", () => {
  it("records a contractor's proposal without messaging the owner again, and a confirmed time without confirming twice", () => {
    const p = onProposalElsewhere(job(), "2026-11-26T03:00:00.000Z", NOW);
    expect(sends(p)).toEqual([]);
    expect(patch(p)).toMatchObject({ proposedBy: "contractor", proposedAt: "2026-11-26T03:00:00.000Z", rounds: 1 });
    const c = onScheduledElsewhere(job(), "2026-11-26T03:00:00.000Z", NOW);
    expect(sends(c)).toEqual([]);
    expect(patch(c)).toMatchObject({ state: "scheduled", appointmentAt: "2026-11-26T03:00:00.000Z" });
    expect(onScheduledElsewhere(job({ state: "delivered" }), "2026-11-26T03:00:00.000Z", NOW)).toEqual([]);
  });
});

describe("reminders and follow-up", () => {
  const ctx = { assignmentStatus: "approved" as const, deliveredFiles: 0 };
  it("reminds the party being waited on, up to the limit, then hands back", () => {
    const waiting = job({ proposedAt: "2026-11-26T03:00:00.000Z", proposedBy: "contractor" });
    expect(sends(onDue(waiting, ctx, NOW))).toEqual(["owner:time_reminder"]);
    const last = onDue({ ...waiting, reminders: LIMITS.maxReminders }, ctx, NOW);
    expect(patch(last).state).toBe("needs_owner");
    expect(sends(last)).toEqual([]);
  });
  it("chases an unanswered request, then hands back", () => {
    const req = job({ state: "requested" });
    expect(sends(onDue(req, { assignmentStatus: "proposed", deliveredFiles: 0 }, NOW))).toEqual(["contractor:request_reminder"]);
    expect(patch(onDue({ ...req, reminders: 3 }, { assignmentStatus: "proposed", deliveredFiles: 0 }, NOW)).state).toBe("needs_owner");
    expect(sends(onDue(req, ctx, NOW))).toEqual(["contractor:ask_time"]);
  });
  it("stops when the job is cancelled or completed", () => {
    expect(patch(onDue(job(), { assignmentStatus: "cancelled", deliveredFiles: 0 }, NOW)).state).toBe("stopped");
  });
  it("sends a reminder before the visit, then moves to awaiting delivery", () => {
    const sched = job({ state: "scheduled", appointmentAt: "2026-11-21T00:00:00.000Z" });
    expect(sends(onDue(sched, ctx, NOW))).toEqual(["contractor:appointment_reminder"]);
    const after = onDue(sched, ctx, "2026-11-21T05:00:00.000Z");
    expect(patch(after).state).toBe("awaiting_delivery");
  });
  it("follows up for uploads, then reports delivery to the owner", () => {
    const wait = job({ state: "awaiting_delivery" });
    expect(sends(onDue(wait, ctx, NOW))).toEqual(["contractor:delivery_followup"]);
    const done = onDue(wait, { ...ctx, deliveredFiles: 4 }, NOW);
    expect(patch(done).state).toBe("delivered");
    expect(sends(done)).toEqual(["owner:delivered_owner"]);
    expect(patch(onDue({ ...wait, reminders: 3 }, ctx, NOW)).state).toBe("needs_owner");
  });
  it("does nothing for finished jobs", () => {
    for (const state of ["delivered", "stopped", "needs_owner"] as const) expect(onDue(job({ state }), ctx, NOW)).toEqual([]);
  });
});

describe("onReply (auto-reply mode)", () => {
  const proposed = job({ proposedAt: "2026-11-26T03:00:00.000Z", proposedBy: "contractor" });
  it("does nothing unless the owner turned Elena on", () => {
    expect(onReply(proposed, "owner", { intent: "accept" }, { ...on, handleJobs: false }, NOW)).toEqual({ steps: [], toOwner: true, reply: false });
  });
  it("handles a yes to a standing proposal as part of the flow, without auto-reply", () => {
    const r = onReply(proposed, "owner", { intent: "accept" }, on, NOW);
    expect(r.toOwner).toBe(false);
    expect(patch(r.steps).state).toBe("scheduled");
  });
  it("never answers money; the owner always sees it", () => {
    const r = onReply(proposed, "contractor", { intent: "money" }, { ...on, autoReply: true }, NOW);
    expect(r).toEqual({ steps: [], toOwner: true, reply: false });
  });
  it("answers other mail only with auto-reply on, and then only with the fixed hand-over note", () => {
    expect(onReply(proposed, "contractor", { intent: "question" }, on, NOW).steps).toEqual([]);
    const r = onReply(proposed, "contractor", { intent: "question" }, { ...on, autoReply: true }, NOW);
    expect(sends(r.steps)).toEqual(["contractor:auto_reply_help"]);
    expect(r.toOwner).toBe(true);
  });
  it("never auto-replies to the owner", () => {
    expect(onReply(proposed, "owner", { intent: "question" }, { ...on, autoReply: true }, NOW)).toMatchObject({ steps: [], toOwner: true, reply: false });
  });
  it("ignores a yes from the person who made the proposal", () => {
    const r = onReply(proposed, "contractor", { intent: "accept" }, on, NOW);
    expect(r.steps).toEqual([]);
    expect(r.toOwner).toBe(true);
  });
});

describe("outbound safety", () => {
  it("every template passes the filter and carries no amounts", () => {
    for (const kind of ["request_reminder", "ask_time", "time_to_confirm", "time_reminder", "time_rejected", "confirmed", "appointment_reminder", "delivery_followup", "delivered_owner", "needs_owner", "files_added", "auto_reply_help"] as const) {
      const d = draftMessage(kind, { ...vars, count: 3, reason: "Please take a look." });
      expect(checkOutbound({ title: d.title, body: `${d.body}\n\n${vars.ref}` })).toEqual({ ok: true });
      expect(d.body).not.toMatch(/\$\d/);
    }
  });
  it("blocks contact details, amounts and abuse", () => {
    expect(checkOutbound({ title: "Hi", body: "Call me on 0412 345 678" }).ok).toBe(false);
    expect(checkOutbound({ title: "Hi", body: "email me at pat@example.com" }).ok).toBe(false);
    expect(checkOutbound({ title: "Hi", body: "The fee is $250 plus GST" }).ok).toBe(false);
    expect(checkOutbound({ title: "x".repeat(2000), body: "ok" }).ok).toBe(false);
  });
  it("limits messages to one person per job per day", () => {
    const t = (h: number) => new Date(new Date(NOW).getTime() - h * 3600_000).toISOString();
    const n = (k: number, h = 1) => Array.from({ length: k }, () => t(h));
    expect(rateLimited(n(LIMITS.maxPerPartyPerDay - 1), NOW)).toBe(false);
    expect(rateLimited(n(LIMITS.maxPerPartyPerDay), NOW)).toBe(true);
    expect(rateLimited([...n(LIMITS.maxPerPartyPerDay - 1), ...n(5, 25)], NOW)).toBe(false);
  });
});

describe("references", () => {
  it("finds the job reference in a subject or reply", () => {
    expect(findJobNo("Re: Please confirm a time: job-5021")).toBe(5021);
    expect(findJobNo("hello")).toBeUndefined();
  });
});
