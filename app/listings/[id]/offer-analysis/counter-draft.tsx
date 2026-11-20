"use client";
import { useState } from "react";
import { dollarsToCents } from "../../../../src/domain/listing-details";
import { JSON_HEADERS } from "../../ui";

type Terms = { priceCents: number; depositCents: number; settlementDays: number; conditions: string[]; expiresInDays: number };
type Draft = { scenario: string; label: string; terms: Terms; reasoning: string[]; closeProbability: number; withinMandate: boolean };
type Alt = { key: string; label: string };
type Reply = { draft: Draft | null; alternatives: Alt[]; summary?: string; note: string; sendNote: string };

const dollars = (cents: number) => (cents / 100).toFixed(2).replace(/\.00$/, "");
const money = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);

/**
 * Elena drafts counter terms for one offer. The owner edits them here and sends them with the same counter route as a hand-typed counter, after a
 * confirmation. Elena never sends, accepts or rejects. An appointed agent sees the draft but cannot send it.
 */
export function CounterDraft({ listingId, offerId, label }: { listingId: string; offerId: string; label: string }) {
  const [reply, setReply] = useState<Reply | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [f, setF] = useState({ price: "", deposit: "", days: "", expires: "", conditions: "" });

  const fill = (t: Terms) => setF({ price: dollars(t.priceCents), deposit: dollars(t.depositCents), days: String(t.settlementDays), expires: String(t.expiresInDays), conditions: t.conditions.join("\n") });

  async function ask(scenario?: string) {
    setBusy(true); setError(""); setSent(false); setConfirm(false);
    try {
      const r = await fetch(`/api/listings/${listingId}/offers/${offerId}/counter-draft`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(scenario ? { scenario } : {}) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(r.status === 429 ? "Too many drafts just now. Try again in a while." : d.error ?? "Elena could not draft a counter."); return; }
      setReply(d as Reply);
      if ((d as Reply).draft) fill((d as Reply).draft!.terms);
    } catch { setError("Elena could not draft a counter."); } finally { setBusy(false); }
  }

  const body = () => {
    const price = dollarsToCents(f.price), deposit = dollarsToCents(f.deposit);
    const days = Number(f.days), expires = Number(f.expires);
    if (price === undefined || deposit === undefined) return undefined;
    return { priceCents: price, depositCents: deposit, settlementDays: days, expiresInDays: expires, conditions: f.conditions.split("\n").map(c => c.trim()).filter(Boolean) };
  };

  async function send() {
    const b = body();
    if (!b) { setError("Enter the price and deposit in dollars, for example 850000."); setConfirm(false); return; }
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/listings/${listingId}/offers/${offerId}/counter`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(b) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setSent(true); setReply(null); } else setError(d.error ?? "The counter could not be sent.");
      setConfirm(false);
    } catch { setError("The counter could not be sent."); setConfirm(false); } finally { setBusy(false); }
  }

  const canSend = reply?.sendNote === "";
  return (
    <div className="cd" aria-live="polite">
      {sent ? <p role="status" className="cd-ok">Counter-offer sent to the buyer of {label}. Its status is now on your offers page.</p> : null}
      {!reply && !sent ? <button type="button" className="secondary" onClick={() => void ask()} disabled={busy}>{busy ? "Drafting…" : `Draft a counter for ${label}`}</button> : null}
      {error ? <p role="alert" className="cd-err">{error}</p> : null}
      {reply ? (
        <div className="cd-box">
          <p className="muted">{reply.note}</p>
          {reply.draft ? (
            <>
              {reply.alternatives.length > 1 ? (
                <div className="cd-alt" role="group" aria-label="Draft style">
                  {reply.alternatives.map(a => <button key={a.key} type="button" className={a.key === reply.draft!.scenario ? "" : "secondary"} aria-pressed={a.key === reply.draft!.scenario} onClick={() => void ask(a.key)} disabled={busy}>{a.label}</button>)}
                </div>
              ) : null}
              <ul className="cd-why">{reply.draft.reasoning.map(r => <li key={r}>{r}</li>)}</ul>
              <form className="cd-form" onSubmit={e => { e.preventDefault(); setConfirm(true); }}>
                <label>Price ($)<input inputMode="decimal" value={f.price} onChange={e => setF({ ...f, price: e.target.value })} required /></label>
                <label>Deposit ($)<input inputMode="decimal" value={f.deposit} onChange={e => setF({ ...f, deposit: e.target.value })} required /></label>
                <label>Settlement (days)<input inputMode="numeric" value={f.days} onChange={e => setF({ ...f, days: e.target.value })} required /></label>
                <label>Buyer has to reply in (days)<input inputMode="numeric" value={f.expires} onChange={e => setF({ ...f, expires: e.target.value })} required /></label>
                <label className="cd-wide">Conditions (one per line)<textarea rows={3} value={f.conditions} onChange={e => setF({ ...f, conditions: e.target.value })} /></label>
                {canSend ? <div className="actions cd-wide"><button type="submit" disabled={busy}>Review and send</button><button type="button" className="secondary" onClick={() => { setReply(null); setConfirm(false); }}>Discard draft</button></div>
                  : <p className="muted cd-wide">{reply.sendNote}</p>}
              </form>
              {confirm ? (
                <div className="confirm-box" role="alertdialog" aria-label="Send this counter-offer?">
                  <strong>Send this counter-offer?</strong>
                  <p>The buyer of {label} is told you countered at {money(dollarsToCents(f.price) ?? 0)}. Nothing is accepted and no money moves on this site.</p>
                  <div className="actions"><button type="button" onClick={() => void send()} disabled={busy}>{busy ? "Sending…" : "Yes, send"}</button><button type="button" className="secondary" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button></div>
                </div>
              ) : null}
            </>
          ) : <button type="button" className="secondary" onClick={() => setReply(null)}>Close</button>}
        </div>
      ) : null}
    </div>
  );
}
