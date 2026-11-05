"use client";
import { useState } from "react";
import { ESCALATION_LABEL, STATUS_LABEL, TYPE_LABEL, type DisputeStatus, type DisputeType, type EscalationReason, type Party, type ResponseKind, type Suggestion } from "../../src/domain/dispute";
import { ElenaFeedback } from "../elena-feedback";
import "../styles/offers.css";
import "../styles/settlement.css";
import "../styles/disputes.css";

export interface Summary {
  id: string; settlementId: string; listingTitle: string; type: DisputeType; title: string; status: DisputeStatus; currentRound: number; initiatedBy: Party;
  deadlineAt: string; createdAt: string; escalationReason: EscalationReason | null; side: Party | "agent" | "staff"; yourTurn: boolean;
}
export interface Round {
  round: number; suggestion: Suggestion; resolved: boolean; buyerResponded: boolean; sellerResponded: boolean;
  buyerResponse: ResponseKind | null; buyerCounterPct: number | null; buyerNote: string | null; sellerResponse: ResponseKind | null; sellerCounterPct: number | null; sellerNote: string | null;
}
export interface Detail extends Summary {
  description: string; claimCents: number | null; buyerPosition: string | null; buyerSharePct: number | null; sellerPosition: string | null; sellerSharePct: number | null;
  agreedSellerSharePct: number | null; outcome: string | null; resolvedAt: string | null; rounds: Round[]; staffActions: { action: string; note: string | null; at: string }[];
  canPosition: boolean; canRespond: boolean; canWithdraw: boolean; escalationText: string | null;
}

export const dollars = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(c / 100);
export const day = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
export const dollarsToCents = (v: string): number | null => { const n = Number(v.replace(/[$,\s]/g, "")); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null; };
const RESPONSE: Record<ResponseKind, string> = { accept: "Accepted", counter: "Countered", escalate: "Asked for staff" };
const ACTION: Record<string, string> = { auto_escalated: "Sent to staff automatically", escalated: "Sent to staff", claimed: "Claimed", noted: "Note", resolved: "Resolved" };

export function Status({ s }: { s: Pick<Summary, "status" | "yourTurn"> }) {
  return <>{s.yourTurn ? <span className="badge badge-turn">Your turn</span> : null} <span className={`badge badge-${s.status}`}>{STATUS_LABEL[s.status]}</span></>;
}

/** A short list of disputes, each linking to its sale's dispute page. */
export function DisputeList({ rows, empty }: { rows: Summary[]; empty: string }) {
  if (rows.length === 0) return <p className="empty">{empty}</p>;
  return (
    <ul className="dsp-list">
      {rows.map(r => (
        <li key={r.id}>
          <div className="dsp-row"><strong className="grow">{r.title}</strong><Status s={r} /></div>
          <p className="muted">{r.listingTitle} · {TYPE_LABEL[r.type]} · round {Math.max(1, r.currentRound)} of 3</p>
          <p><a href={`/settlements/${r.settlementId}/disputes#${r.id}`}>Open dispute</a></p>
        </li>
      ))}
    </ul>
  );
}

/** Elena's suggestion for one round: the split, why, how similar disputes ended, the risk and wording to reuse. */
export function ElenaPanel({ s, claimCents, onPick }: { s: Suggestion; claimCents: number | null; onPick?: (text: string) => void }) {
  return (
    <section className="dsp-elena" aria-label={`Elena's suggestion for round ${s.round}`}>
      <h3>Elena suggests: {s.headline}</h3>
      {s.sellerSharePct !== null ? (
        <>
          <div className="dsp-split" role="img" aria-label={`Buyer ${s.buyerSharePct} percent, seller ${s.sellerSharePct} percent`}>
            <span className="buyer" style={{ width: `${s.buyerSharePct}%` }} /><span className="seller" style={{ width: `${s.sellerSharePct}%` }} />
          </div>
          <p className="dsp-legend">
            <span>Buyer {s.buyerSharePct}%{claimCents !== null && s.buyerPaysCents !== null ? ` (${dollars(s.buyerPaysCents)})` : ""}</span>
            <span>Seller {s.sellerSharePct}%{claimCents !== null && s.sellerPaysCents !== null ? ` (${dollars(s.sellerPaysCents)})` : ""}</span>
          </p>
        </>
      ) : null}
      <ul>{s.reasoning.map(x => <li key={x}>{x}</li>)}</ul>
      <p>{s.history ? `Similar disputes: the seller covered about ${s.history.medianSellerSharePct}% (${s.history.samples} cases).` : "Similar disputes: not enough past cases on the platform yet."}</p>
      <div className="dsp-risk">
        <span className={`badge ${s.risk.level === "high" ? "badge-escalated" : ""}`}>Risk: {s.risk.level}</span>
        {s.risk.likelyFallThrough ? <span className="dsp-risk-high">Likely to lead to a fall-through without help.</span> : null}
      </div>
      <ul>{s.risk.reasons.map(x => <li key={x}>{x}</li>)}</ul>
      {onPick ? (
        <>
          <p className="dsp-note">Wording you can use when you answer:</p>
          <ul className="dsp-templates">{s.templates.map(t => <li key={t.label}><button type="button" className="secondary" onClick={() => onPick(t.text)}>{t.label}</button></li>)}</ul>
        </>
      ) : null}
      <p className="dsp-note">{s.disclaimer}</p>
    </section>
  );
}

function Rounds({ d }: { d: Detail }) {
  return (
    <ol className="dsp-rounds" aria-label="Mediation rounds">
      {d.rounds.map(r => (
        <li key={r.round}>
          <strong>Round {r.round}</strong>
          <ElenaPanel s={r.suggestion} claimCents={d.claimCents} />
          <p>Buyer: {r.buyerResponse ? `${RESPONSE[r.buyerResponse]}${r.buyerCounterPct !== null ? `, seller covers ${r.buyerCounterPct}%` : ""}` : r.buyerResponded ? "Answered (hidden until both answer)" : "Not answered yet"}{r.buyerNote ? `: ${r.buyerNote}` : ""}</p>
          <p>Seller: {r.sellerResponse ? `${RESPONSE[r.sellerResponse]}${r.sellerCounterPct !== null ? `, seller covers ${r.sellerCounterPct}%` : ""}` : r.sellerResponded ? "Answered (hidden until both answer)" : "Not answered yet"}{r.sellerNote ? `: ${r.sellerNote}` : ""}</p>
        </li>
      ))}
    </ol>
  );
}

/** One dispute in full. `post` sends an action and reloads; party actions only show when the server says they are allowed. */
export function DisputeDetail({ d, post, busy, staff }: { d: Detail; post?: (body: Record<string, unknown>) => Promise<void>; busy: boolean; staff?: React.ReactNode }) {
  const hasClaim = d.claimCents !== null;
  const [position, setPosition] = useState(""), [share, setShare] = useState("50"), [note, setNote] = useState(""), [choice, setChoice] = useState<ResponseKind>("accept");
  const sharePct = Number(share), badShare = hasClaim && !(Number.isInteger(sharePct) && sharePct >= 0 && sharePct <= 100);
  const current = d.rounds.find(r => r.round === d.currentRound);
  return (
    <article className="dsp-card" id={d.id}>
      <div className="dsp-row"><h2 className="grow">{d.title}</h2><Status s={d} /></div>
      <p className="muted">{TYPE_LABEL[d.type]} · {d.listingTitle}{d.claimCents !== null ? ` · ${dollars(d.claimCents)} in dispute` : ""} · raised by the {d.initiatedBy}</p>
      <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{d.description}</p>
      <dl className="dsp-positions">
        <div><dt>Buyer wants{d.buyerSharePct !== null ? ` (seller covers ${d.buyerSharePct}%)` : ""}</dt><dd>{d.buyerPosition ?? "Not given yet"}</dd></div>
        <div><dt>Seller wants{d.sellerSharePct !== null ? ` (seller covers ${d.sellerSharePct}%)` : ""}</dt><dd>{d.sellerPosition ?? "Not given yet"}</dd></div>
      </dl>
      {d.status === "awaiting_position" ? <p role="status">Elena starts once both sides have given their position. It goes to staff on {day(d.deadlineAt)} if it is not settled by then.</p> : null}
      {d.status === "mediating" ? <p className="dsp-note">Round {d.currentRound} of 3. It goes to staff after round 3, if someone asks, or on {day(d.deadlineAt)}.</p> : null}
      {d.status === "escalated" ? <p role="status"><strong>With staff.</strong> {d.escalationText}. A staff member will review and record the outcome.</p> : null}
      {d.outcome ? <p role="status"><strong>Outcome:</strong> {d.outcome}</p> : null}
      {post && (d.status === "agreed" || d.status === "resolved") && (d.side === "buyer" || d.side === "seller") ? <ElenaFeedback overall={{ kind: "dispute", subjectId: d.id }} question="Did Elena's mediation help?" /> : null}
      {d.rounds.length ? <Rounds d={d} /> : null}

      {post && d.canPosition ? (
        <form className="dsp-respond" onSubmit={e => { e.preventDefault(); void post({ action: "position", position, sellerSharePct: hasClaim ? sharePct : null }); }}>
          <h3>Add your side</h3>
          <label>What do you want to happen?<textarea required rows={4} maxLength={2000} value={position} onChange={e => setPosition(e.target.value)} /></label>
          {hasClaim ? <label>Share of {dollars(d.claimCents!)} the seller should cover (0 to 100)<input type="number" min={0} max={100} step={1} required value={share} onChange={e => setShare(e.target.value)} /></label> : null}
          <button type="submit" disabled={busy || !position.trim() || badShare}>Send my side to Elena</button>
        </form>
      ) : null}

      {post && d.canRespond && current ? (
        <form className="dsp-respond" onSubmit={e => { e.preventDefault(); void post({ action: "respond", response: choice, sellerSharePct: choice === "counter" && hasClaim ? sharePct : null, note: note.trim() || null }); }}>
          <h3>Your answer to round {current.round}</h3>
          <label>Answer
            <select value={choice} onChange={e => setChoice(e.target.value as ResponseKind)}>
              <option value="accept">Accept Elena's suggestion</option><option value="counter">Make a counter</option><option value="escalate">Ask for staff to step in</option>
            </select>
          </label>
          {choice === "counter" && hasClaim ? <label>Share the seller should cover in your counter (0 to 100)<input type="number" min={0} max={100} step={1} required value={share} onChange={e => setShare(e.target.value)} /></label> : null}
          <label>{choice === "counter" && !hasClaim ? "What do you propose instead?" : "Note (optional)"}<textarea rows={3} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} required={choice === "counter" && !hasClaim} /></label>
          <p className="dsp-note">Your answer stays private until the other side has answered too.</p>
          <button type="submit" disabled={busy || (choice === "counter" && hasClaim && badShare) || (choice === "counter" && !hasClaim && !note.trim())}>Send my answer</button>
        </form>
      ) : null}
      {post && d.canRespond === false && d.status === "mediating" && (d.side === "buyer" || d.side === "seller") ? <p className="muted" role="status">You have answered this round. Waiting for the other side.</p> : null}
      {post && d.canWithdraw ? <div className="dsp-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void post({ action: "withdraw" })}>Withdraw this dispute</button></div> : null}

      {d.staffActions.length ? (
        <>
          <h3>Staff history</h3>
          <ul>{d.staffActions.map((a, i) => <li key={i}>{day(a.at)}: {ACTION[a.action] ?? a.action}{a.note ? `. ${a.note}` : ""}</li>)}</ul>
        </>
      ) : null}
      {staff}
      {d.status === "escalated" || d.status === "resolved" ? null : <p className="dsp-note">{ESCALATION_LABEL.timeout} unless settled first. Elena suggests only; this is not legal advice.</p>}
    </article>
  );
}
