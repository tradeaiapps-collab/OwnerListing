// Deposits held in trust: pure rules. The platform never holds money; the deposit sits in the solicitor's verified trust account.
// This module decides what the record says (balances, status), what staff may do next, and how a bank statement reconciles.
import { MIN_REASON, reasonOk } from "./staff-admin";

export type HoldingStatus = "open" | "released" | "refunded" | "cancelled";
export type MovementKind = "receipt" | "release" | "refund";
export type ReleaseKind = "release" | "refund";
export type ReleaseStatus = "pending" | "approved" | "rejected";
/** What a person sees: the stored status refined by the money that has moved. */
export type DisplayStatus = "awaiting" | "part_received" | "held" | "release_pending" | "released" | "refunded" | "cancelled";

export interface DepositHolding {
  id: string; listingId: string; listingTitle: string; offerId: string; trustAccountId: string; trustAccountLabel: string;
  reference: string; requiredCents: number; dueDate: string | null; status: HoldingStatus; closedReason: string | null; createdAt: string;
  offerPriceCents: number; buyerName: string;
}
export interface DepositMovement {
  id: string; holdingId: string; kind: MovementKind; amountCents: number; occurredOn: string; bankReference: string | null;
  releaseId: string | null; recordedBy: string; createdAt: string; reconciled: boolean;
}
export interface DepositRelease {
  id: string; holdingId: string; kind: ReleaseKind; amountCents: number; reason: string; settlementConfirmed: boolean;
  requestedBy: string; requestedAt: string; status: ReleaseStatus; decidedBy: string | null; decidedAt: string | null; decisionReason: string | null;
}
export interface StatementLine {
  id: string; trustAccountId: string; lineDate: string; amountCents: number; description: string; reference: string;
  matchedMovementId: string | null;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const bad = (error: string): Result<never> => ({ ok: false, error });

export const MAX_CENTS = 100_000_000_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (v: unknown): v is string => typeof v === "string" && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const isCents = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= MAX_CENTS;

// ---------- references ----------

const REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O or 1/I, easy to read out over the phone
/** A deposit reference such as DEP-7K3QX9, from six random bytes supplied by the caller. */
export function depositReference(bytes: Uint8Array): string {
  if (bytes.length < 6) throw new Error("Need six random bytes.");
  let s = "";
  for (let i = 0; i < 6; i++) s += REF_ALPHABET[bytes[i]! % REF_ALPHABET.length];
  return `DEP-${s}`;
}
const squash = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, "");
/** True when the bank text quotes the reference, ignoring case, spaces and dashes ("dep 7k3qx9" matches DEP-7K3QX9). */
export const mentionsReference = (text: string, reference: string) => squash(text).includes(squash(reference));

// ---------- balances and status ----------

export interface Balance { receivedCents: number; paidOutCents: number; heldCents: number; outstandingCents: number }
export function balanceOf(requiredCents: number, movements: readonly Pick<DepositMovement, "kind" | "amountCents">[]): Balance {
  let received = 0, out = 0;
  for (const m of movements) {
    if (m.kind === "receipt") received += m.amountCents;
    else out += m.amountCents;
  }
  return { receivedCents: received, paidOutCents: out, heldCents: received - out, outstandingCents: Math.max(0, requiredCents - received) };
}

export function displayStatus(h: Pick<DepositHolding, "status" | "requiredCents">, movements: readonly Pick<DepositMovement, "kind" | "amountCents">[],
  releases: readonly Pick<DepositRelease, "status">[]): DisplayStatus {
  if (h.status !== "open") return h.status;
  if (releases.some(r => r.status === "pending")) return "release_pending";
  const b = balanceOf(h.requiredCents, movements);
  if (b.receivedCents === 0) return "awaiting";
  return b.outstandingCents > 0 ? "part_received" : "held";
}

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  awaiting: "Awaiting deposit", part_received: "Part received", held: "Held in trust", release_pending: "Release waiting approval",
  released: "Released to seller", refunded: "Refunded to buyer", cancelled: "Cancelled"
};

/** Overdue: still open, money still owed, and the due date has passed. */
export const isOverdue = (h: Pick<DepositHolding, "status" | "dueDate">, b: Balance, today: string) =>
  h.status === "open" && b.outstandingCents > 0 && h.dueDate !== null && h.dueDate < today;

// ---------- input parsing ----------

export interface NewHoldingInput { offerId: string; requiredCents: number | null; dueDate: string | null }
export function parseNewHolding(body: Record<string, unknown> | null): Result<NewHoldingInput> {
  if (!body) return bad("Send the offer.");
  const offerId = body["offerId"];
  if (typeof offerId !== "string" || !/^[0-9a-f-]{36}$/i.test(offerId)) return bad("Choose an accepted offer.");
  const req = body["requiredCents"] ?? null;
  if (req !== null && !isCents(req)) return bad("Enter the deposit amount in whole cents, more than zero.");
  const due = body["dueDate"] ?? null;
  if (due !== null && !isIsoDate(due)) return bad("Enter the due date as YYYY-MM-DD.");
  return ok({ offerId, requiredCents: req as number | null, dueDate: due as string | null });
}

export interface ReceiptInput { amountCents: number; receivedOn: string; bankReference: string | null }
export function parseReceipt(body: Record<string, unknown>, today: string): Result<ReceiptInput> {
  const amount = body["amountCents"], on = body["receivedOn"], ref = body["bankReference"] ?? null;
  if (!isCents(amount)) return bad("Enter the amount received, more than zero.");
  if (!isIsoDate(on)) return bad("Enter the date the bank shows the money arrived (YYYY-MM-DD).");
  if (on > today) return bad("The date received cannot be in the future.");
  if (ref !== null && (typeof ref !== "string" || ref.trim().length > 100)) return bad("The bank reference is at most 100 characters.");
  const r = typeof ref === "string" && ref.trim() ? ref.trim() : null;
  return ok({ amountCents: amount, receivedOn: on, bankReference: r });
}

export interface ReleaseRequestInput { kind: ReleaseKind; amountCents: number; reason: string; settlementConfirmed: boolean }
export function parseReleaseRequest(body: Record<string, unknown>): Result<ReleaseRequestInput> {
  const kind = body["kind"];
  if (kind !== "release" && kind !== "refund") return bad("Choose release to the seller or refund to the buyer.");
  if (!isCents(body["amountCents"])) return bad("Enter the amount to pay out, more than zero.");
  if (!reasonOk(body["reason"])) return bad(`A reason of at least ${MIN_REASON} characters is required.`);
  const settled = body["settlementConfirmed"] === true;
  if (kind === "release" && !settled) return bad("Confirm that settlement is complete before asking to release the deposit to the seller.");
  return ok({ kind, amountCents: body["amountCents"] as number, reason: (body["reason"] as string).trim(), settlementConfirmed: settled });
}

// ---------- rules for each action ----------

export type Plan = { allow: true } | { allow: false; status: number; error: string };
const yes: Plan = { allow: true };
const no = (status: number, error: string): Plan => ({ allow: false, status, error });

export function planReceipt(h: Pick<DepositHolding, "status" | "requiredCents">, movements: readonly Pick<DepositMovement, "kind" | "amountCents">[], amountCents: number): Plan {
  if (h.status !== "open") return no(409, "This deposit record is closed.");
  const b = balanceOf(h.requiredCents, movements);
  if (b.paidOutCents > 0) return no(409, "Money has already been paid out of this deposit.");
  if (amountCents > b.outstandingCents) return no(409, `That is more than the deposit still owed (${b.outstandingCents} cents).`);
  return yes;
}

export function planReleaseRequest(h: Pick<DepositHolding, "status" | "requiredCents">, movements: readonly Pick<DepositMovement, "kind" | "amountCents">[],
  releases: readonly Pick<DepositRelease, "status">[], input: ReleaseRequestInput): Plan {
  if (h.status !== "open") return no(409, "This deposit record is closed.");
  if (releases.some(r => r.status === "pending")) return no(409, "A release or refund is already waiting for approval.");
  const b = balanceOf(h.requiredCents, movements);
  if (b.heldCents <= 0) return no(409, "Nothing is held in trust for this deposit yet.");
  if (input.amountCents > b.heldCents) return no(409, "That is more than is held in trust for this deposit.");
  if (input.kind === "release" && b.outstandingCents > 0) return no(409, "The full deposit has not been received, so it cannot be released to the seller. Refund it instead, or record the rest first.");
  return yes;
}

/** Two people: whoever asked for the payment can never approve it. */
export function planReleaseDecision(actorId: string, r: Pick<DepositRelease, "status" | "requestedBy">, outcome: unknown, reason: unknown,
  heldCents: number, amountCents: number): Plan {
  if (outcome !== "approve" && outcome !== "reject") return no(400, "Choose approve or reject.");
  if (!reasonOk(reason)) return no(400, `A reason of at least ${MIN_REASON} characters is required.`);
  if (r.status !== "pending") return no(409, "This request has already been decided.");
  if (r.requestedBy === actorId) return no(403, "A second person must decide. You asked for this payment.");
  if (outcome === "approve" && amountCents > heldCents) return no(409, "Less is held in trust than this request; reject it and ask again.");
  return yes;
}

export function planCancel(h: Pick<DepositHolding, "status">, movements: readonly unknown[], releases: readonly Pick<DepositRelease, "status">[]): Plan {
  if (h.status !== "open") return no(409, "This deposit record is already closed.");
  if (movements.length > 0) return no(409, "Money has been recorded against this deposit. Refund it instead of cancelling.");
  if (releases.some(r => r.status === "pending")) return no(409, "A request is waiting for approval.");
  return yes;
}

/** After an approved payment: the record closes once nothing is left in trust. */
export function statusAfterPayout(kind: ReleaseKind, heldAfterCents: number): HoldingStatus {
  if (heldAfterCents > 0) return "open";
  return kind === "release" ? "released" : "refunded";
}

// ---------- bank statement CSV ----------

export interface ParsedLine { lineDate: string; amountCents: number; description: string; reference: string; occurrence: number }
export interface ParsedStatement { lines: ParsedLine[]; errors: string[] }
export const MAX_STATEMENT_LINES = 5000;

/** Splits CSV text into rows, honouring quoted fields with commas, doubled quotes and line breaks. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some(x => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x.trim() !== "")) rows.push(row);
  return rows;
}

/** "$1,234.56", "-1234.5", "(1,234.56)" and "1234.56 DR" to signed cents; NaN when it is not an amount. */
export function amountToCents(raw: string): number {
  let s = raw.trim().toUpperCase();
  if (!s) return Number.NaN;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (s.endsWith("DR")) { sign = -sign; s = s.slice(0, -2).trim(); } else if (s.endsWith("CR")) s = s.slice(0, -2).trim();
  if (s.startsWith("-")) { sign = -sign; s = s.slice(1); } else if (s.startsWith("+")) s = s.slice(1);
  s = s.replace(/^\$/, "").replace(/,/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return Number.NaN;
  const [whole, frac = ""] = s.split(".");
  return sign * (Number(whole) * 100 + Number(frac.padEnd(2, "0")));
}

/** Australian bank exports: YYYY-MM-DD or DD/MM/YYYY (also D/M/YYYY and DD-MM-YYYY). */
export function statementDate(raw: string): string | null {
  const s = raw.trim();
  if (isIsoDate(s)) return s;
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return isIsoDate(iso) ? iso : null;
}

const HEAD = {
  date: ["date", "transaction date", "posted date", "value date"],
  amount: ["amount", "amount (aud)", "transaction amount"],
  debit: ["debit", "debit amount", "withdrawal", "withdrawals"],
  credit: ["credit", "credit amount", "deposit", "deposits"],
  description: ["description", "narrative", "details", "transaction details", "particulars"],
  reference: ["reference", "ref", "payment reference", "lodgement reference"]
};

/**
 * Reads a bank statement CSV with a header row. Needs a date column and either an amount column (signed) or debit and
 * credit columns. Description and reference are optional. Rows that cannot be read are reported, not guessed.
 * Identical rows (two equal deposits on one day) are kept apart by their occurrence number.
 */
export function parseStatementCsv(text: string): ParsedStatement {
  const rows = csvRows(text);
  if (rows.length < 2) return { lines: [], errors: ["The file needs a header row and at least one transaction."] };
  const head = rows[0]!.map(h => h.trim().toLowerCase());
  const col = (names: string[]) => head.findIndex(h => names.includes(h));
  const iDate = col(HEAD.date), iAmt = col(HEAD.amount), iDr = col(HEAD.debit), iCr = col(HEAD.credit), iDesc = col(HEAD.description), iRef = col(HEAD.reference);
  if (iDate < 0) return { lines: [], errors: ["No date column found. Name it Date."] };
  if (iAmt < 0 && (iDr < 0 || iCr < 0)) return { lines: [], errors: ["No amount column found. Use Amount, or Debit and Credit."] };
  if (rows.length - 1 > MAX_STATEMENT_LINES) return { lines: [], errors: [`At most ${MAX_STATEMENT_LINES} transactions per file.`] };

  const lines: ParsedLine[] = [], errors: string[] = [];
  const seen = new Map<string, number>();
  rows.slice(1).forEach((r, n) => {
    const rowNo = n + 2;
    const date = statementDate(r[iDate] ?? "");
    let cents: number;
    if (iAmt >= 0) cents = amountToCents(r[iAmt] ?? "");
    else {
      const dr = (r[iDr] ?? "").trim(), cr = (r[iCr] ?? "").trim();
      cents = dr && cr ? Number.NaN : dr ? -Math.abs(amountToCents(dr)) : cr ? Math.abs(amountToCents(cr)) : Number.NaN;
    }
    if (!date) { errors.push(`Row ${rowNo}: the date is not readable.`); return; }
    if (!Number.isFinite(cents) || cents === 0 || Math.abs(cents) > MAX_CENTS) { errors.push(`Row ${rowNo}: the amount is not readable.`); return; }
    const description = (iDesc >= 0 ? r[iDesc] ?? "" : "").trim().slice(0, 300);
    const reference = (iRef >= 0 ? r[iRef] ?? "" : "").trim().slice(0, 100);
    const key = lineKey({ lineDate: date, amountCents: cents, description, reference, occurrence: 0 });
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    lines.push({ lineDate: date, amountCents: cents, description, reference, occurrence });
  });
  return { lines, errors };
}

/** The content a line's fingerprint is hashed from. Re-importing the same statement gives the same keys. */
export const lineKey = (l: ParsedLine) => [l.lineDate, l.amountCents, l.description.replace(/\s+/g, " ").toLowerCase(), l.reference.toLowerCase(), l.occurrence].join("|");

// ---------- reconciliation ----------

export type Suggestion =
  | { kind: "new_receipt"; holdingId: string; reference: string; amountCents: number }
  | { kind: "match"; movementId: string; holdingId: string; reference: string; movementKind: MovementKind };

export interface HoldingForMatch { id: string; reference: string; trustAccountId: string; status: HoldingStatus; requiredCents: number }

const daysApart = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/**
 * Proposes what an unmatched statement line is. A person always confirms; nothing is matched automatically.
 * 1. A ledger entry already recorded by hand with the same amount and direction, quoting the reference or within 7 days.
 * 2. A credit quoting an open deposit's reference, not more than is still owed: a new receipt.
 */
export function suggestFor(line: StatementLine, holdings: readonly HoldingForMatch[], movements: readonly DepositMovement[]): Suggestion | null {
  if (line.matchedMovementId) return null;
  const text = `${line.description} ${line.reference}`;
  const mine = holdings.filter(h => h.trustAccountId === line.trustAccountId);
  const byId = new Map(mine.map(h => [h.id, h]));
  const credit = line.amountCents > 0;
  const candidates = movements.filter(m => !m.reconciled && byId.has(m.holdingId) && (m.kind === "receipt") === credit && m.amountCents === Math.abs(line.amountCents));
  const quoted = candidates.filter(m => mentionsReference(text, byId.get(m.holdingId)!.reference));
  const near = candidates.filter(m => daysApart(m.occurredOn, line.lineDate) <= 7);
  const pick = quoted.length === 1 ? quoted[0] : quoted.length === 0 && near.length === 1 ? near[0] : undefined;
  if (pick) return { kind: "match", movementId: pick.id, holdingId: pick.holdingId, reference: byId.get(pick.holdingId)!.reference, movementKind: pick.kind };
  if (!credit) return null;
  const quotedHoldings = mine.filter(h => h.status === "open" && mentionsReference(text, h.reference));
  if (quotedHoldings.length !== 1) return null;
  const h = quotedHoldings[0]!;
  const b = balanceOf(h.requiredCents, movements.filter(m => m.holdingId === h.id));
  if (b.paidOutCents > 0 || line.amountCents > b.outstandingCents) return null;
  return { kind: "new_receipt", holdingId: h.id, reference: h.reference, amountCents: line.amountCents };
}

/** Can this statement line back this ledger entry? Same account, same direction, same amount, both unmatched. */
export function planMatch(line: StatementLine, m: DepositMovement, holdingAccountId: string): Plan {
  if (line.matchedMovementId) return no(409, "This statement line is already matched.");
  if (m.reconciled) return no(409, "This ledger entry is already matched to another statement line.");
  if (line.trustAccountId !== holdingAccountId) return no(409, "The statement line is from a different trust account.");
  if ((m.kind === "receipt") !== (line.amountCents > 0)) return no(409, "Money in must match a receipt, money out a release or refund.");
  if (m.amountCents !== Math.abs(line.amountCents)) return no(409, "The amounts differ.");
  return yes;
}

export interface Reconciliation {
  ledgerHeldCents: number; unmatchedMovements: number; unmatchedLines: number; matchedLines: number; reconciled: boolean;
}
/** Per trust account: every ledger entry should be backed by a bank line. Unrelated bank lines (other clients' money) are expected. */
export function reconciliationSummary(movements: readonly DepositMovement[], lines: readonly StatementLine[]): Reconciliation {
  const held = movements.reduce((s, m) => s + (m.kind === "receipt" ? m.amountCents : -m.amountCents), 0);
  const unmatchedMovements = movements.filter(m => !m.reconciled).length;
  const matchedLines = lines.filter(l => l.matchedMovementId).length;
  return { ledgerHeldCents: held, unmatchedMovements, unmatchedLines: lines.length - matchedLines, matchedLines, reconciled: unmatchedMovements === 0 };
}
