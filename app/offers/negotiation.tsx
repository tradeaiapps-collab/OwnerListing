"use client";
import { useState } from "react";
import { DEFAULT_COUNTER_DAYS, MAX_COUNTER_DAYS } from "../../src/domain/offer-counter";
import { offerStatusLabel } from "../../src/domain/offer-display";
import { describeEvent, type TimelineEvent } from "../../src/domain/offer-timeline";
import { dollarsToCents, parseConditionLines } from "../../src/domain/offer-form";

export type Terms = { priceCents: number; depositCents: number; settlementDays: number; conditions: string[] };
export type Counter = Terms & { id: string; round: number; fromParty: "owner" | "buyer"; status: string; createdAt: string; expiresAt: string; closedAt?: string };

export const dollars = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
export const when = (iso: string) => new Date(iso).toLocaleString("en-AU");

export function TermsLine({ t }: { t: Terms }) {
  return (
    <>
      <div><strong>{dollars(t.priceCents)}</strong> · Deposit {dollars(t.depositCents)} · Settlement {t.settlementDays} days</div>
      <div>{t.conditions.length > 0 ? `Conditions: ${t.conditions.join("; ")}` : "No conditions"}</div>
    </>
  );
}

/** The offer's full history, oldest first: every step, who took it (by role only) and the terms it put on the table. */
export function OfferTimeline({ events, viewer }: { events: TimelineEvent[]; viewer: "owner" | "buyer" }) {
  if (events.length === 0) return <p className="muted">No history yet.</p>;
  return (
    <ol className="timeline">
      {events.map(e => (
        <li key={e.id} className={`timeline-${e.type}`}>
          <time dateTime={e.occurredAt}>{when(e.occurredAt)}</time>
          <div><strong>{describeEvent(e, viewer)}</strong> <span className={`badge badge-${e.toStatus}`}>{offerStatusLabel(e.toStatus, viewer)}</span></div>
          {e.terms ? <TermsLine t={e.terms} /> : null}
        </li>
      ))}
    </ol>
  );
}

/** Counter-offer form, pre-filled with the terms on the table. Posts dollars as whole cents. */
export function CounterForm({ start, onSubmit, busy, submitLabel }: { start: Terms; onSubmit: (body: Terms & { expiresInDays: number }) => void; busy: boolean; submitLabel: string }) {
  const [price, setPrice] = useState(String(start.priceCents / 100));
  const [deposit, setDeposit] = useState(String(start.depositCents / 100));
  const [days, setDays] = useState(String(start.settlementDays));
  const [conditions, setConditions] = useState(start.conditions.join("\n"));
  const [expires, setExpires] = useState(String(DEFAULT_COUNTER_DAYS));
  const [error, setError] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const priceCents = dollarsToCents(price);
    const depositCents = deposit.trim() === "" ? 0 : dollarsToCents(deposit);
    const settlementDays = Number(days);
    const expiresInDays = Number(expires);
    const list = parseConditionLines(conditions);
    if (priceCents === undefined || priceCents <= 0) return setError("Enter the price as dollars, for example 850000.");
    if (depositCents === undefined || depositCents > priceCents) return setError("Deposit must be a dollar amount that is not more than the price.");
    if (!Number.isInteger(settlementDays) || settlementDays < 1 || settlementDays > 365) return setError("Settlement must be 1 to 365 days.");
    if (list.length > 10) return setError("Use at most 10 conditions.");
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > MAX_COUNTER_DAYS) return setError(`Reply time must be 1 to ${MAX_COUNTER_DAYS} days.`);
    setError("");
    onSubmit({ priceCents, depositCents, settlementDays, conditions: list, expiresInDays });
  };

  return (
    <form className="offer-form" onSubmit={submit}>
      <label>Price (AUD)<input inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} /></label>
      <label>Deposit (AUD)<input inputMode="decimal" value={deposit} onChange={e => setDeposit(e.target.value)} /></label>
      <label>Settlement (days)<input inputMode="numeric" value={days} onChange={e => setDays(e.target.value)} /></label>
      <label>Conditions <span className="hint">One per line, up to 10.</span><textarea rows={3} value={conditions} onChange={e => setConditions(e.target.value)} /></label>
      <label>Reply within (days) <span className="hint">After this the counter-offer lapses and the offer expires.</span><input inputMode="numeric" value={expires} onChange={e => setExpires(e.target.value)} /></label>
      {error ? <p role="alert">{error}</p> : null}
      <div className="actions"><button type="submit" disabled={busy}>{busy ? "Sending…" : submitLabel}</button></div>
    </form>
  );
}
