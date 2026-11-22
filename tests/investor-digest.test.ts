import { describe, expect, it } from "vitest";
import { buildDigest, isDue, parseInvestorDigestInput, windowStart, type DigestAnswer, type DigestUpdate } from "../src/domain/investor-digest";
import { isKind, renderNotification } from "../src/domain/notifications";

const upd = (n: number, p = "p1"): DigestUpdate => ({ projectId: p, projectTitle: `Project ${p}`, title: `Update ${n}`, body: "Slab poured on level two, ahead of schedule. ".repeat(10), at: "2026-11-20T00:00:00Z" });
const ans = (by: "elena" | "owner"): DigestAnswer => ({ projectId: "p1", projectTitle: "Project p1", question: "When is completion?", answer: "Practical completion is planned for June.", by, at: "2026-11-20T00:00:00Z" });

describe("investor weekly digest rules", () => {
  it("is due once a week, and a first digest covers the past week", () => {
    const now = "2026-11-21T00:00:00Z";
    expect(isDue(null, now)).toBe(true);
    expect(isDue("2026-11-15T00:00:01Z", now)).toBe(false);
    expect(isDue("2026-11-14T00:00:00Z", now)).toBe(true);
    expect(windowStart(null, now)).toBe("2026-11-14T00:00:00.000Z");
    expect(windowStart("2026-11-15T00:00:00Z", now)).toBe("2026-11-15T00:00:00.000Z");
  });
  it("sends nothing in a quiet week", () => { expect(buildDigest([], [])).toBeNull(); });
  it("summarises updates and answers, says who answered, and stays inside the email budget", () => {
    const d = buildDigest([upd(1), upd(2), upd(3), upd(4)], [ans("elena"), ans("owner")])!;
    expect(d.title).toBe("Your weekly project update: 4 new updates and 2 answered questions");
    expect(d.text).toContain("Elena answered");
    expect(d.text).toContain("The owner replied");
    expect(d.text).toContain("and 1 more update");
    expect(d.text.length).toBeLessThanOrEqual(1400);
    expect(d.text).toContain("turn this weekly email off");
  });
  it("caps the number of projects shown", () => {
    const d = buildDigest(Array.from({ length: 9 }, (_, i) => upd(1, `p${i}`)), [])!;
    expect(d.text).toContain("and 3 more projects");
  });
  it("renders as a notification kind that follows the messages category", () => {
    expect(isKind("investor_digest")).toBe(true);
    const r = renderNotification("investor_digest", { title: "T", text: "Body" });
    expect(r.category).toBe("messages");
    expect(r.smsText).toBeNull();
  });
  it("accepts only { enabled: boolean }", () => {
    expect(parseInvestorDigestInput({ enabled: false })).toEqual({ ok: true, enabled: false });
    for (const bad of [null, [], {}, { enabled: "yes" }, { enabled: true, extra: 1 }]) expect(parseInvestorDigestInput(bad).ok).toBe(false);
  });
});
