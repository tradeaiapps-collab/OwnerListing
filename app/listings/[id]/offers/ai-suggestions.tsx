"use client";
import { useState } from "react";
import { JSON_HEADERS } from "../../ui";

type Violation = { code: string; message: string };
type Draft = { id: string; action: "recommend_counter" | "request_information" | "reject"; text: string; status: "pending" | "held"; violations: Violation[] };
type Analysis = {
  priceCents: number; askingPriceCents?: number; gapToAskingPercent?: number; depositPercent: number; rankAmongOpen: number; openOffers: number;
  flags: { code: string; text: string }[]; handoff: boolean; handoffReasons: string[];
  counter?: { amountCents: number; rangeLowCents: number; rangeHighCents: number; rationale: string[] };
  policy: { reason: string };
};
type Result = { analysis: Analysis; aiAvailable: boolean; canSendInThread: boolean; drafts: Draft[] };

const dollars = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(cents / 100);
const ACTION_LABEL: Record<Draft["action"], string> = { recommend_counter: "Counter-offer", request_information: "Ask for details", reject: "Decline politely" };

/**
 * AI suggestions for one offer: the rules-based analysis, a suggested counter range, and drafts the seller can edit and send into
 * the buyer's conversation. There is never an accept button here: accepting stays the owner's own decision above.
 */
export function AiSuggestions({ listingId, offerId }: { listingId: string; offerId: string }) {
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [edited, setEdited] = useState<Record<string, boolean>>({});
  const [done, setDone] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<Record<string, Violation[]>>({});

  async function load() {
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/listings/${listingId}/offers/${offerId}/ai/suggestions`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
      const d = await r.json();
      if (!r.ok) { setError(d.error ?? "Could not load suggestions."); return; }
      setRes(d);
      setTexts(Object.fromEntries((d as Result).drafts.map(x => [x.id, x.text])));
      setProblems(Object.fromEntries((d as Result).drafts.map(x => [x.id, x.violations])));
    } catch { setError("Could not load suggestions."); } finally { setBusy(false); }
  }

  async function send(d: Draft) {
    setBusy(true);
    try {
      const body = edited[d.id] ? { mode: "edited", text: texts[d.id] ?? "" } : { mode: "as_is" };
      const r = await fetch(`/api/ai/drafts/${d.id}/send`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) setDone({ ...done, [d.id]: "Sent to the buyer's conversation." });
      else { setProblems({ ...problems, [d.id]: j.violations ?? [] }); setDone({ ...done, [d.id]: j.error ?? "Could not send." }); }
    } catch { setDone({ ...done, [d.id]: "Could not send." }); } finally { setBusy(false); }
  }

  if (!res) {
    return (
      <div className="ai-note">
        <button type="button" className="secondary" disabled={busy} onClick={() => void load()}>{busy ? "Working…" : "AI suggestions"}</button>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  }
  const a = res.analysis;
  return (
    <div className="ai-note" aria-label="AI suggestions">
      <strong>Suggestions</strong> (advice for you only; nothing is sent or accepted)
      <p>
        {a.gapToAskingPercent !== undefined ? `${a.gapToAskingPercent > 0 ? "+" : ""}${a.gapToAskingPercent}% against your asking price. ` : ""}
        Deposit {a.depositPercent}%. Rank {a.rankAmongOpen} of {a.openOffers} open offer{a.openOffers === 1 ? "" : "s"}.
      </p>
      {a.flags.length > 0 && <ul>{a.flags.map(f => <li key={f.code}>{f.text}</li>)}</ul>}
      {a.handoff && <p role="note"><strong>Your call:</strong> {a.handoffReasons.join(" ")}</p>}
      {a.counter && (
        <div>
          <p>Suggested counter: <strong>{dollars(a.counter.amountCents)}</strong> (range {dollars(a.counter.rangeLowCents)} to {dollars(a.counter.rangeHighCents)}).</p>
          <ul>{a.counter.rationale.map(r => <li key={r}>{r}</li>)}</ul>
        </div>
      )}
      <p className="muted">{a.policy.reason}</p>
      {!res.aiAvailable && <p className="muted">AI drafts are unavailable right now. The analysis above is worked out without AI.</p>}
      {res.drafts.length > 0 && !res.canSendInThread && <p className="muted">This buyer has no conversation with you yet, so copy a draft into your own message.</p>}
      {res.drafts.map(d => (
        <form key={d.id} className="stack" onSubmit={e => { e.preventDefault(); void send(d); }}>
          <h3>{ACTION_LABEL[d.action]}</h3>
          {d.status === "held" && !edited[d.id] && <p role="alert">This draft did not pass the checks. Edit it before sending.</p>}
          {(problems[d.id] ?? []).length > 0 && <ul>{(problems[d.id] ?? []).map(v => <li key={v.code}>{v.message}</li>)}</ul>}
          <textarea rows={5} maxLength={3800} aria-label={`${ACTION_LABEL[d.action]} draft`} value={texts[d.id] ?? ""}
            onChange={e => { setTexts({ ...texts, [d.id]: e.target.value }); setEdited({ ...edited, [d.id]: true }); }} />
          {res.canSendInThread && !done[d.id]?.startsWith("Sent") && <button type="submit" disabled={busy || !(texts[d.id] ?? "").trim()}>Send to buyer</button>}
          {done[d.id] && <p role="status">{done[d.id]}</p>}
        </form>
      ))}
    </div>
  );
}
