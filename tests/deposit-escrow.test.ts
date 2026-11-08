import { describe, expect, it } from "vitest";
import {
  amountToCents, balanceOf, csvRows, depositReference, displayStatus, isOverdue, lineKey, mentionsReference, parseNewHolding, parseReceipt,
  parseReleaseRequest, parseStatementCsv, planCancel, planMatch, planReceipt, planReleaseDecision, planReleaseRequest, reconciliationSummary,
  statementDate, statusAfterPayout, suggestFor, type DepositMovement, type StatementLine
} from "../src/domain/deposit-escrow";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const mv = (o: Partial<DepositMovement>): DepositMovement => ({
  id: U(50), holdingId: U(1), kind: "receipt", amountCents: 5_000_000, occurredOn: "2026-11-02", bankReference: null, releaseId: null, recordedBy: U(9),
  createdAt: "2026-11-02T00:00:00Z", reconciled: false, ...o
});
const line = (o: Partial<StatementLine>): StatementLine => ({
  id: U(70), trustAccountId: U(20), lineDate: "2026-11-03", amountCents: 5_000_000, description: "TFR FROM J CITIZEN DEP-7K3QX9", reference: "", matchedMovementId: null, ...o
});
const open = { status: "open" as const, requiredCents: 5_000_000 };

describe("deposit references", () => {
  it("are DEP- and six readable characters, and match bank text loosely", () => {
    const r = depositReference(new Uint8Array([0, 1, 2, 3, 4, 255]));
    expect(r).toMatch(/^DEP-[2-9A-HJ-NP-Z]{6}$/);
    expect(mentionsReference("tfr dep 7k3 qx9 smith", "DEP-7K3QX9")).toBe(true);
    expect(mentionsReference("deposit 7K3QX8", "DEP-7K3QX9")).toBe(false);
    expect(() => depositReference(new Uint8Array(3))).toThrow();
  });
});

describe("balances and status", () => {
  it("adds receipts, takes off payouts and works out what is still owed", () => {
    const b = balanceOf(5_000_000, [mv({ amountCents: 2_000_000 }), mv({ amountCents: 3_000_000 }), mv({ kind: "release", amountCents: 1_000_000 })]);
    expect(b).toEqual({ receivedCents: 5_000_000, paidOutCents: 1_000_000, heldCents: 4_000_000, outstandingCents: 0 });
  });
  it("shows awaiting, part received, held, pending and closed", () => {
    expect(displayStatus(open, [], [])).toBe("awaiting");
    expect(displayStatus(open, [mv({ amountCents: 1 })], [])).toBe("part_received");
    expect(displayStatus(open, [mv({})], [])).toBe("held");
    expect(displayStatus(open, [mv({})], [{ status: "pending" }])).toBe("release_pending");
    expect(displayStatus({ ...open, status: "released" }, [mv({})], [])).toBe("released");
  });
  it("flags an overdue deposit only while money is still owed", () => {
    const h = { status: "open" as const, dueDate: "2026-11-01" };
    expect(isOverdue(h, balanceOf(5_000_000, []), "2026-11-02")).toBe(true);
    expect(isOverdue(h, balanceOf(5_000_000, [mv({})]), "2026-11-02")).toBe(false);
    expect(isOverdue({ ...h, dueDate: null }, balanceOf(5_000_000, []), "2026-11-02")).toBe(false);
  });
  it("closes the record only when nothing is left held", () => {
    expect(statusAfterPayout("release", 0)).toBe("released");
    expect(statusAfterPayout("refund", 0)).toBe("refunded");
    expect(statusAfterPayout("release", 1)).toBe("open");
  });
});

describe("input", () => {
  it("parses a new record", () => {
    expect(parseNewHolding({ offerId: U(3) })).toEqual({ ok: true, value: { offerId: U(3), requiredCents: null, dueDate: null } });
    expect(parseNewHolding({ offerId: U(3), requiredCents: 0 }).ok).toBe(false);
    expect(parseNewHolding({ offerId: U(3), dueDate: "2026-02-30" }).ok).toBe(false);
    expect(parseNewHolding({ offerId: "x" }).ok).toBe(false);
    expect(parseNewHolding(null).ok).toBe(false);
  });
  it("parses a receipt and refuses future dates", () => {
    expect(parseReceipt({ amountCents: 100, receivedOn: "2026-11-01", bankReference: "  ABC " }, "2026-11-05")).toEqual({ ok: true, value: { amountCents: 100, receivedOn: "2026-11-01", bankReference: "ABC" } });
    expect(parseReceipt({ amountCents: 100, receivedOn: "2026-11-06" }, "2026-11-05").ok).toBe(false);
    expect(parseReceipt({ amountCents: 1.5, receivedOn: "2026-11-01" }, "2026-11-05").ok).toBe(false);
  });
  it("needs a reason, and confirmed settlement to release to the seller", () => {
    expect(parseReleaseRequest({ kind: "release", amountCents: 100, reason: "Settled on 4 Nov per solicitor" }).ok).toBe(false);
    expect(parseReleaseRequest({ kind: "release", amountCents: 100, reason: "Settled on 4 Nov per solicitor", settlementConfirmed: true }).ok).toBe(true);
    expect(parseReleaseRequest({ kind: "refund", amountCents: 100, reason: "short" }).ok).toBe(false);
    expect(parseReleaseRequest({ kind: "refund", amountCents: 100, reason: "Finance clause not met, contract ended" })).toMatchObject({ ok: true, value: { settlementConfirmed: false } });
    expect(parseReleaseRequest({ kind: "steal", amountCents: 100, reason: "xxxxxxxxxxxx" }).ok).toBe(false);
  });
});

describe("rules", () => {
  it("receipts cannot exceed what is owed or follow a payout", () => {
    expect(planReceipt(open, [], 5_000_000)).toEqual({ allow: true });
    expect(planReceipt(open, [mv({ amountCents: 4_000_000 })], 2_000_000)).toMatchObject({ allow: false, status: 409 });
    expect(planReceipt({ ...open, status: "cancelled" }, [], 1)).toMatchObject({ allow: false });
    expect(planReceipt(open, [mv({ amountCents: 1_000_000 }), mv({ kind: "refund", amountCents: 1_000_000 })], 1)).toMatchObject({ allow: false });
  });
  it("a release needs the full deposit held and only one request at a time", () => {
    const rel = { kind: "release" as const, amountCents: 5_000_000, reason: "x".repeat(10), settlementConfirmed: true };
    expect(planReleaseRequest(open, [], [], rel)).toMatchObject({ allow: false, error: expect.stringContaining("Nothing is held") });
    expect(planReleaseRequest(open, [mv({ amountCents: 1_000_000 })], [], { ...rel, amountCents: 1_000_000 })).toMatchObject({ allow: false, error: expect.stringContaining("full deposit") });
    expect(planReleaseRequest(open, [mv({ amountCents: 1_000_000 })], [], { ...rel, kind: "refund", amountCents: 1_000_000 })).toEqual({ allow: true });
    expect(planReleaseRequest(open, [mv({})], [], rel)).toEqual({ allow: true });
    expect(planReleaseRequest(open, [mv({})], [], { ...rel, amountCents: 5_000_001 })).toMatchObject({ allow: false });
    expect(planReleaseRequest(open, [mv({})], [{ status: "pending" }], rel)).toMatchObject({ allow: false, status: 409 });
  });
  it("the person who asked can never approve; a reason is always needed", () => {
    const r = { status: "pending" as const, requestedBy: U(1) };
    expect(planReleaseDecision(U(1), r, "approve", "Checked with the solicitor", 5, 5)).toMatchObject({ allow: false, status: 403 });
    expect(planReleaseDecision(U(2), r, "approve", "short", 5, 5)).toMatchObject({ allow: false, status: 400 });
    expect(planReleaseDecision(U(2), r, "maybe", "Checked with the solicitor", 5, 5)).toMatchObject({ allow: false, status: 400 });
    expect(planReleaseDecision(U(2), { ...r, status: "approved" }, "approve", "Checked with the solicitor", 5, 5)).toMatchObject({ allow: false, status: 409 });
    expect(planReleaseDecision(U(2), r, "approve", "Checked with the solicitor", 4, 5)).toMatchObject({ allow: false, status: 409 });
    expect(planReleaseDecision(U(2), r, "reject", "Settlement has not happened", 4, 5)).toEqual({ allow: true });
    expect(planReleaseDecision(U(2), r, "approve", "Checked with the solicitor", 5, 5)).toEqual({ allow: true });
  });
  it("cancel only before any money", () => {
    expect(planCancel({ status: "open" }, [], [])).toEqual({ allow: true });
    expect(planCancel({ status: "open" }, [mv({})], [])).toMatchObject({ allow: false });
    expect(planCancel({ status: "released" }, [], [])).toMatchObject({ allow: false });
  });
});

describe("bank statement CSV", () => {
  it("reads quoted fields, commas, doubled quotes and line breaks", () => {
    expect(csvRows('a,"b, c","d ""e"""\r\n\r\n1,2,"3\n4"\n')).toEqual([["a", "b, c", 'd "e"'], ["1", "2", "3\n4"]]);
  });
  it("reads Australian amounts and dates", () => {
    expect(amountToCents("$1,234.56")).toBe(123_456);
    expect(amountToCents("-50")).toBe(-5000);
    expect(amountToCents("(12.5)")).toBe(-1250);
    expect(amountToCents("99.10 DR")).toBe(-9910);
    expect(amountToCents("99.10 CR")).toBe(9910);
    expect(amountToCents("12.345")).toBeNaN();
    expect(amountToCents("abc")).toBeNaN();
    expect(statementDate("3/11/2026")).toBe("2026-11-03");
    expect(statementDate("2026-11-03")).toBe("2026-11-03");
    expect(statementDate("31/02/2026")).toBeNull();
    expect(statementDate("11/3/26")).toBeNull();
  });
  it("parses a signed amount file and reports unreadable rows", () => {
    const p = parseStatementCsv("﻿Date,Description,Amount,Reference\n03/11/2026,TFR J CITIZEN,\"50,000.00\",DEP-7K3QX9\n04/11/2026,Fee,-12.00,\nbad,x,1,\n05/11/2026,x,zero,\n");
    expect(p.lines).toEqual([
      { lineDate: "2026-11-03", amountCents: 5_000_000, description: "TFR J CITIZEN", reference: "DEP-7K3QX9", occurrence: 0 },
      { lineDate: "2026-11-04", amountCents: -1200, description: "Fee", reference: "", occurrence: 0 }
    ]);
    expect(p.errors).toEqual(["Row 4: the date is not readable.", "Row 5: the amount is not readable."]);
  });
  it("parses debit and credit columns and keeps identical lines apart", () => {
    const p = parseStatementCsv("Transaction Date,Narrative,Debit,Credit\n2026-11-03,Deposit,,1000.00\n2026-11-03,Deposit,,1000.00\n2026-11-04,Payment,250.00,\n");
    expect(p.lines.map(l => [l.amountCents, l.occurrence])).toEqual([[100_000, 0], [100_000, 1], [-25_000, 0]]);
    expect(lineKey(p.lines[0]!)).not.toBe(lineKey(p.lines[1]!));
  });
  it("refuses a file without the needed columns", () => {
    expect(parseStatementCsv("Description,Amount\nx,1\n").errors[0]).toMatch(/date column/);
    expect(parseStatementCsv("Date,Description\n2026-11-03,x\n").errors[0]).toMatch(/amount column/);
    expect(parseStatementCsv("Date,Amount\n").errors[0]).toMatch(/header row/);
  });
});

describe("reconciliation", () => {
  const holdings = [{ id: U(1), reference: "DEP-7K3QX9", trustAccountId: U(20), status: "open" as const, requiredCents: 5_000_000 }];
  it("suggests a new receipt for a credit quoting an open deposit's reference", () => {
    expect(suggestFor(line({}), holdings, [])).toEqual({ kind: "new_receipt", holdingId: U(1), reference: "DEP-7K3QX9", amountCents: 5_000_000 });
    expect(suggestFor(line({ amountCents: 6_000_000 }), holdings, [])).toBeNull();
    expect(suggestFor(line({ trustAccountId: U(21) }), holdings, [])).toBeNull();
    expect(suggestFor(line({ matchedMovementId: U(50) }), holdings, [])).toBeNull();
  });
  it("prefers a ledger entry already recorded by hand", () => {
    expect(suggestFor(line({ description: "TFR" }), holdings, [mv({})])).toMatchObject({ kind: "match", movementId: U(50), movementKind: "receipt" });
    expect(suggestFor(line({ description: "TFR", lineDate: "2026-12-30" }), holdings, [mv({})])).toBeNull();
    expect(suggestFor(line({ amountCents: -5_000_000, description: "PAY SELLER DEP-7K3QX9" }), holdings,
      [mv({ kind: "release", id: U(51) }), mv({})])).toMatchObject({ kind: "match", movementId: U(51), movementKind: "release" });
    expect(suggestFor(line({ amountCents: -5_000_000, description: "Office rent", lineDate: "2026-12-30" }), holdings, [])).toBeNull();
  });
  it("matches only same account, direction and amount", () => {
    expect(planMatch(line({}), mv({}), U(20))).toEqual({ allow: true });
    expect(planMatch(line({}), mv({}), U(21))).toMatchObject({ allow: false });
    expect(planMatch(line({}), mv({ kind: "release" }), U(20))).toMatchObject({ allow: false });
    expect(planMatch(line({ amountCents: 1 }), mv({}), U(20))).toMatchObject({ allow: false });
    expect(planMatch(line({}), mv({ reconciled: true }), U(20))).toMatchObject({ allow: false });
    expect(planMatch(line({ matchedMovementId: U(9) }), mv({}), U(20))).toMatchObject({ allow: false });
  });
  it("summarises an account", () => {
    const s = reconciliationSummary([mv({ reconciled: true }), mv({ kind: "release", amountCents: 1_000_000 })], [line({ matchedMovementId: U(50) }), line({ id: U(71) })]);
    expect(s).toEqual({ ledgerHeldCents: 4_000_000, unmatchedMovements: 1, unmatchedLines: 1, matchedLines: 1, reconciled: false });
  });
});
