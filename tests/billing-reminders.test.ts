import { describe, expect, it } from "vitest";
import { daysOverdue, isOverdue, reminderEmail, reminderToSend, type ReminderStage } from "../src/domain/billing-reminders";

const DUE = "2026-11-10T00:00:00.000Z";
const at = (days: number) => new Date(Date.parse(DUE) + days * 86_400_000).toISOString();
const inv = { status: "pending" as const, dueAt: DUE };
const none = new Set<ReminderStage>();

describe("payment reminders", () => {
  it("send nothing until 3 days before the due date", () => {
    expect(reminderToSend(inv, at(-4), none)).toBeNull();
    expect(reminderToSend(inv, at(-3), none)).toBe("upcoming");
  });
  it("move through due, overdue and final", () => {
    expect(reminderToSend(inv, at(0), none)).toBe("due");
    expect(reminderToSend(inv, at(3), none)).toBe("overdue");
    expect(reminderToSend(inv, at(10), none)).toBe("final");
    expect(reminderToSend(inv, at(60), none)).toBe("final");
  });
  it("never repeat a stage already sent, and send only the latest stage reached (no burst)", () => {
    expect(reminderToSend(inv, at(0), new Set<ReminderStage>(["due"]))).toBeNull();
    expect(reminderToSend(inv, at(4), new Set<ReminderStage>(["upcoming"]))).toBe("overdue");
  });
  it("send nothing for paid, failed, void or undated invoices", () => {
    for (const status of ["paid", "failed", "void", "refunded"] as const) expect(reminderToSend({ status, dueAt: DUE }, at(5), none)).toBeNull();
    expect(reminderToSend({ status: "pending" }, at(5), none)).toBeNull();
  });
  it("measure overdue days", () => {
    expect(isOverdue(inv, at(-1))).toBe(false);
    expect(isOverdue(inv, at(1))).toBe(true);
    expect(isOverdue({ status: "paid", dueAt: DUE }, at(5))).toBe(false);
    expect(daysOverdue(inv, at(4.5))).toBe(4);
    expect(daysOverdue(inv, at(-2))).toBe(0);
  });
  it("write plain emails that name the invoice and never ask for card or login details", () => {
    for (const stage of ["upcoming", "due", "overdue", "final"] as const) {
      const m = reminderEmail(stage, { invoiceNumber: "INV-001042", totalCents: 11_000, dueAt: DUE }, "OwnerListing", "https://example.com/billing");
      expect(m.subject).toContain("INV-001042");
      expect(m.text).toContain("$110.00");
      expect(m.text).toContain("https://example.com/billing");
      expect(m.text).toMatch(/never ask you for card numbers or passwords/);
      expect(m.text).not.toMatch(/<|href=/);
    }
    expect(reminderEmail("final", { invoiceNumber: "INV-1", totalCents: 100, dueAt: DUE }, "X", "u").subject).toMatch(/^X: Final reminder/);
  });
});
