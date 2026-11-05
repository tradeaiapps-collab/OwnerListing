"use client";
import { useState } from "react";
import { ElenaFeedback } from "../../../elena-feedback";
import { JSON_HEADERS } from "../../ui";

type Violation = { code: string; message: string };
type Template = { id: string; kind: string; label: string; text: string; status: "pending" | "held"; violations: Violation[] };
type Scenario = {
  key: "firm" | "balanced" | "quick"; label: string; priceCents: number; depositPercent: number; settlementDays: number; conditionsKept: string[];
  conditionsDropped: string[]; expiryDays: number; costContributionCents: number; concessions: { text: string }[];
  acceptProbability: number; completionProbability: number; closeProbability: number; expectedNetCents: number; withinMandate: boolean; reasoning: string[];
};
type Coach = {
  summary: string;
  likelihoodAsIs: { probability: number; drivers: { label: string; effect: "helps" | "hurts" }[] };
  buyer: { momentum: string };
  risk: { score: number; level: "low" | "medium" | "high"; parts: { key: string; score: number; note: string }[] };
  redFlags: { code: string; text: string }[];
  analysis: { flags: { code: string; text: string }[]; handoff: boolean; handoffReasons: string[] };
  scenarios: Scenario[]; recommended?: Scenario["key"];
  concessionIdeas: { text: string }[];
  strategy?: { ranking: { offerId: string; label: string; expectedNetCents: number; closeProbability: number; riskLevel: string }[]; notes: string[]; bestAndFinalAdvised: boolean };
  model: { source: "prior" | "learned"; trainedOn: number };
  canSendInThread?: boolean; templates?: Template[];
};

const dollars = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(c / 100);
const pct = (p: number) => `${Math.round(p * 100)}%`;
const SCENARIO_TEMPLATE: Record<Scenario["key"], string> = { firm: "counter_firm", balanced: "counter_balanced", quick: "counter_quick" };

/**
 * Elena's negotiation coach for one offer: close chance, risk, red flags, three counter scenarios and editable message templates.
 * Advice for the seller only. There is no accept button; sending a template uses the same checked draft step as every AI draft.
 */
export function NegotiationCoach({ listingId, offerId }: { listingId: string; offerId: string }) {
  const [res, setRes] = useState<Coach | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mention, setMention] = useState(false);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [edited, setEdited] = useState<Record<string, boolean>>({});
  const [done, setDone] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<Record<string, Violation[]>>({});

  async function load(mentionOtherOffers = mention) {
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/listings/${listingId}/offers/${offerId}/coach`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ mentionOtherOffers }) });
      const d = await r.json();
      if (!r.ok) { setError(d.error ?? "Could not load the coach."); return; }
      const c = d as Coach;
      setRes(c); setEdited({}); setDone({});
      setTexts(Object.fromEntries((c.templates ?? []).map(t => [t.id, t.text])));
      setProblems(Object.fromEntries((c.templates ?? []).map(t => [t.id, t.violations])));
    } catch { setError("Could not load the coach."); } finally { setBusy(false); }
  }

  async function send(t: Template) {
    setBusy(true);
    try {
      const body = edited[t.id] ? { mode: "edited", text: texts[t.id] ?? "" } : { mode: "as_is" };
      const r = await fetch(`/api/ai/drafts/${t.id}/send`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) setDone(d => ({ ...d, [t.id]: "Sent to the buyer's conversation." }));
      else { setProblems(p => ({ ...p, [t.id]: j.violations ?? [] })); setDone(d => ({ ...d, [t.id]: j.error ?? "Could not send." })); }
    } catch { setDone(d => ({ ...d, [t.id]: "Could not send." })); } finally { setBusy(false); }
  }

  if (!res) {
    return (
      <div className="coach">
        <button type="button" className="secondary" disabled={busy} onClick={() => void load()}>{busy ? "Elena is thinking…" : "Negotiation coach"}</button>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  }
  const covered = new Set(res.redFlags.map(f => f.code));
  const flags = [...res.redFlags, ...res.analysis.flags.filter(f => !(f.code === "low_deposit" && (covered.has("no_deposit") || covered.has("thin_deposit"))) && !(f.code === "subject_to_sale" && covered.has("sale_dependent_thin")))];
  const jump = (s: Scenario) => document.getElementById(`coach-${offerId}-${SCENARIO_TEMPLATE[s.key]}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  return (
    <section className="coach coach-open" aria-label="Negotiation coach">
      <header className="coach-head">
        <img src="/assistant/elena-icon.png" alt="" width={44} height={44} />
        <div>
          <strong>Elena, negotiation coach</strong>
          <p>{res.summary}</p>
        </div>
      </header>

      <div className="coach-stats">
        <div>
          <span className="coach-label">Chance this offer ends in a signed contract</span>
          <div className="coach-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(res.likelihoodAsIs.probability * 100)} aria-label="Close chance">
            <span style={{ width: pct(res.likelihoodAsIs.probability) }} />
          </div>
          <strong>{pct(res.likelihoodAsIs.probability)}</strong>
        </div>
        <div>
          <span className="coach-label">Risk</span>
          <strong><span className={`badge coach-risk-${res.risk.level}`}>{res.risk.level}</span> {res.risk.score}/100</strong>
          <small className="muted">Buyer is {res.buyer.momentum === "unknown" ? "making a first offer" : res.buyer.momentum}</small>
        </div>
      </div>

      {res.likelihoodAsIs.drivers.length > 0 && <ul className="coach-list">{res.likelihoodAsIs.drivers.map(d => <li key={d.label} className={`coach-${d.effect}`}>{d.effect === "helps" ? "Helps: " : "Hurts: "}{d.label}</li>)}</ul>}
      {flags.length > 0 && (
        <div role="note">
          <strong>Watch for</strong>
          <ul className="coach-list">{flags.map(f => <li key={f.code + f.text}>{f.text}</li>)}</ul>
        </div>
      )}
      {res.analysis.handoff && <p role="note"><strong>Your call:</strong> {res.analysis.handoffReasons.join(" ")}</p>}

      {res.scenarios.length > 0 && (
        <>
          <h3>Counter-offer options</h3>
          <div className="coach-scenarios">
            {res.scenarios.map(s => (
              <article key={s.key} className={`coach-card${res.recommended === s.key ? " coach-best" : ""}`}>
                <h4>{s.label}{res.recommended === s.key ? <span className="badge badge-open">Best expected result</span> : null}</h4>
                <p className="coach-price">{dollars(s.priceCents)}</p>
                <p className="coach-odds"><strong>{pct(s.closeProbability)}</strong> to close <small className="muted">({pct(s.acceptProbability)} they take it × {pct(s.completionProbability)} it completes)</small></p>
                <ul className="coach-list">
                  <li>{s.depositPercent}% deposit, {s.settlementDays}-day settlement</li>
                  <li>{s.conditionsKept.length ? `Keeps: ${s.conditionsKept.join("; ")}` : "No conditions"}</li>
                  {s.conditionsDropped.length > 0 && <li>Asks to drop: {s.conditionsDropped.join("; ")}</li>}
                  {s.concessions.map(c => <li key={c.text}>{c.text}</li>)}
                  <li>Open for {s.expiryDays} days</li>
                </ul>
                <small className="muted">{s.reasoning.join(" ")}</small>
                <button type="button" className="secondary" onClick={() => jump(s)}>Use this wording</button>
              </article>
            ))}
          </div>
        </>
      )}

      {res.concessionIdeas.length > 0 && (
        <details>
          <summary>Concessions to trade (cheapest first)</summary>
          <ul className="coach-list">{res.concessionIdeas.map(c => <li key={c.text}>{c.text}</li>)}</ul>
          <small className="muted">General information, not legal advice. Check conditions and clauses with your conveyancer.</small>
        </details>
      )}

      {res.strategy && res.strategy.ranking.length > 1 && (
        <div>
          <h3>All open offers</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Offer</th><th scope="col" className="num">Expected result</th><th scope="col" className="num">Chance to close</th><th scope="col">Risk</th></tr></thead>
              <tbody>{res.strategy.ranking.map(r => (
                <tr key={r.offerId}><th scope="row">{r.label}{r.offerId === offerId ? " (this one)" : ""}</th><td className="num">{dollars(r.expectedNetCents)}</td><td className="num">{pct(r.closeProbability)}</td><td>{r.riskLevel}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
      {res.strategy && res.strategy.notes.length > 0 && <ul className="coach-list">{res.strategy.notes.map(n => <li key={n}>{n}</li>)}</ul>}

      {res.templates && res.templates.length > 0 && (
        <>
          <h3>Messages you can edit and send</h3>
          <label className="check"><input type="checkbox" checked={mention} onChange={e => { setMention(e.target.checked); void load(e.target.checked); }} /> I am happy to tell the buyer there are other offers</label>
          {!res.canSendInThread && <p className="muted">This buyer has no conversation with you yet, so copy a message into your own reply.</p>}
          {res.templates.map(t => (
            <form key={t.id} id={`coach-${offerId}-${t.kind}`} className="stack" onSubmit={e => { e.preventDefault(); void send(t); }}>
              <h4>{t.label}</h4>
              {t.status === "held" && !edited[t.id] && <p role="alert">This message did not pass the checks. Edit it before sending.</p>}
              {(problems[t.id] ?? []).length > 0 && <ul>{(problems[t.id] ?? []).map(v => <li key={v.code}>{v.message}</li>)}</ul>}
              <textarea rows={7} maxLength={3800} aria-label={`${t.label} message`} value={texts[t.id] ?? ""} onChange={e => { setTexts({ ...texts, [t.id]: e.target.value }); setEdited({ ...edited, [t.id]: true }); }} />
              {res.canSendInThread && !done[t.id]?.startsWith("Sent") && <button type="submit" disabled={busy || !(texts[t.id] ?? "").trim()}>Send to buyer</button>}
              {done[t.id] && <p role="status">{done[t.id]}</p>}
              {done[t.id] && <ElenaFeedback suggestionId={t.id} />}
            </form>
          ))}
        </>
      )}
      <small className="muted">
        {res.model.source === "learned" ? `Close chances are learned from ${res.model.trainedOn} past offers on this platform.` : "Close chances use Elena's built-in starting weights; they will adapt as more offers close or fail."}
        {" "}Elena suggests; only you accept, counter or decline.
      </small>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

type Pasted = {
  parsed: { priceCents?: number; depositCents?: number; settlementDays?: number; conditions: string[]; pressure: string[]; missing: string[] };
  assumed?: { settlementDays: boolean; deposit: boolean };
  coach: Coach | null;
};

/** Paste an offer that arrived by email or text. Elena reads the terms and coaches on them. Nothing is stored or sent. */
export function PasteOffer({ listingId }: { listingId: string }) {
  const [text, setText] = useState("");
  const [res, setRes] = useState<Pasted | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run() {
    setBusy(true); setError(""); setRes(null);
    try {
      const r = await fetch(`/api/listings/${listingId}/coach/parse`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ text }) });
      const d = await r.json();
      if (!r.ok) setError(d.error ?? "Could not read that offer."); else setRes(d as Pasted);
    } catch { setError("Could not read that offer."); } finally { setBusy(false); }
  }
  const p = res?.parsed;
  return (
    <section className="panel">
      <h2>Paste an offer for Elena to read</h2>
      <p className="muted">For an offer that arrived by email or text. Elena reads the price and terms and coaches you. Nothing is saved or sent.</p>
      <label className="stack">
        <span className="muted">Offer text</span>
        <textarea rows={4} maxLength={4000} value={text} onChange={e => setText(e.target.value)} placeholder="e.g. We offer $850,000 with a 10% deposit, 45 day settlement, subject to finance." />
      </label>
      <button type="button" disabled={busy || text.trim().length < 5} onClick={() => void run()}>{busy ? "Reading…" : "Read and coach"}</button>
      {error && <p role="alert">{error}</p>}
      {p && (
        <div role="status">
          <p>
            Elena read: {p.priceCents !== undefined ? <strong>{dollars(p.priceCents)}</strong> : "no price"}
            {p.depositCents !== undefined ? `, deposit ${dollars(p.depositCents)}` : ""}
            {p.settlementDays !== undefined ? `, settlement ${p.settlementDays} days` : ""}
            {p.conditions.length ? `, ${p.conditions.join(", ").toLowerCase()}` : ", no conditions"}.
          </p>
          {p.missing.length > 0 && <p className="muted">Could not find: {p.missing.join(", ")}. {p.priceCents === undefined ? "Add the price and try again." : "Elena assumed typical terms for those."}</p>}
          {p.pressure.length > 0 && <ul className="coach-list">{p.pressure.map(x => <li key={x}>{x}</li>)}</ul>}
          {res?.coach && <><p>{res.coach.summary}</p>
            {res.coach.scenarios.length > 0 && <ul className="coach-list">{res.coach.scenarios.map(s => <li key={s.key}>{s.label}: {dollars(s.priceCents)}, about {pct(s.closeProbability)} to close</li>)}</ul>}</>}
        </div>
      )}
    </section>
  );
}
