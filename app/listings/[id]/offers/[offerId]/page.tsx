"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { formatAud, formatPrice } from "../../../../../src/domain/listing-details";
import type { OwnerDecision } from "../../../../../src/domain/offer-decision";
import { MAX_COUNTER_ROUNDS } from "../../../../../src/domain/offer-counter";
import {
  depositBps, formatBps, historyWithDeltas, isOpen, versusAsking, type OfferDetail
} from "../../../../../src/domain/offer-detail";
import { offerStatusLabel } from "../../../../../src/domain/offer-display";
import { describeEvent, type TimelineEvent } from "../../../../../src/domain/offer-timeline";
import { CounterForm, type Counter, type Terms } from "../../../../offers/negotiation";
import { JSON_HEADERS } from "../../../ui";
import "../../../../styles/cards.css";
import "../../../../styles/offers.css";

const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

type Negotiation = {
  awaiting: "owner" | "buyer" | null; standing: Terms; round: number;
  openCounter?: Terms & { id: string; expiresAt: string }; counters: Counter[]; timeline: TimelineEvent[];
};
type Detail = OfferDetail & { negotiation: Negotiation };
type Action = OwnerDecision | "counter";

const ACTIONS: Record<Action, { button: string; title: string; text: string; confirm: string; tone: "primary" | "secondary" | "danger" }> = {
  accept: { button: "Accept offer", title: "Accept this offer?", confirm: "Yes, accept this offer", tone: "primary",
    text: "This records your decision. No money moves on this site; the deposit goes to your solicitor's trust account." },
  counter_request: { button: "Ask for a better offer", title: "Ask the buyer to improve their offer?", confirm: "Yes, ask for a counter", tone: "secondary",
    text: "The buyer is asked to send a new offer. Nothing is accepted, and this offer stays on record." },
  reject: { button: "Reject offer", title: "Reject this offer?", confirm: "Yes, reject", tone: "danger",
    text: "The buyer is told it was not accepted. This cannot be undone; they can still make a new offer." },
  counter: { button: "Counter with your terms", title: "Send a counter-offer", confirm: "Send counter-offer", tone: "secondary",
    text: "The buyer can agree, counter back or withdraw. Nothing is accepted until you accept." }
};

/** What the owner may do now. While the owner's own counter waits for the buyer there is nothing to do but wait. */
function allowedActions(status: string, n: Negotiation): Action[] {
  const canCounter = n.round < MAX_COUNTER_ROUNDS;
  if (status === "countered") return n.openCounter ? [] : ["accept", "reject"];
  if (status === "buyer_countered") return canCounter ? ["accept", "counter", "reject"] : ["accept", "reject"];
  if (status === "submitted" || status === "under_review") return canCounter ? ["accept", "counter", "counter_request", "reject"] : ["accept", "counter_request", "reject"];
  return [];
}

/** Owner and appointed-agent view of one formal offer. Only the owner decides; the AI never accepts and is not an actor here. */
export default function OfferDetailPage() {
  const { id, offerId } = useParams<{ id: string; offerId: string }>();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const load = () => fetch(`/api/listings/${id}/offers/${offerId}`)
    .then(async r => {
      const body = await r.json().catch(() => ({}));
      if (r.ok) setD(body);
      else setError(r.status === 401 ? "Sign in to see this offer." : r.status === 404 ? "Offer not found." : body.error ?? "Could not load the offer.");
    })
    .catch(() => setError("Could not load the offer."));

  useEffect(() => { setD(null); setError(""); load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id, offerId]);

  async function send(url: string, payload: unknown, ok: string) {
    setBusy(true); setNotice("");
    const r = await fetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(payload) }).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) : {};
    setBusy(false); setPending(null);
    setNotice(r?.ok ? ok : body.error ?? "Could not record that decision.");
    load();
  }
  const decide = () => { if (pending && pending !== "counter") void send(`/api/listings/${id}/offers/${offerId}/decision`, { decision: pending }, "Decision recorded."); };

  const crumbs = (
    <nav className="crumbs" aria-label="Breadcrumb">
      <ol><li><a href="/listings/mine">My listings</a></li><li><a href={`/listings/${id}/offers`}>Offers</a></li><li aria-current="page">Offer</li></ol>
    </nav>
  );
  if (error) return <main>{crumbs}<p role="alert">{error}</p></main>;
  if (!d) return <main>{crumbs}<p className="muted" role="status">Loading the offer...</p></main>;

  const o = d.offer;
  const tx = d.listing.transactionType;
  const vs = versusAsking(o.priceCents, d.listing.askingPriceCents);
  const n = d.negotiation;
  const s = n.standing;
  const latest = n.counters.at(-1);
  const history = historyWithDeltas(d.history);
  const open = isOpen(o.status);
  const allowed = open ? allowedActions(o.status, n) : [];
  const verified = [d.buyer.emailVerified && "Email", d.buyer.phoneVerified && "Phone", d.buyer.idVerified && "ID"].filter(Boolean) as string[];

  return (
    <main className="offer-detail">
      {crumbs}
      <header className="od-head">
        <div>
          <p className="od-eyebrow">Offer on <a href={`/listings/${d.listing.id}`}>{d.listing.title}</a></p>
          <h1>{formatPrice(o.priceCents, tx)} <span className={`badge badge-${o.status}`}>{offerStatusLabel(o.status, "owner", latest)}</span></h1>
          <p className="muted od-sub">{d.listing.address} · received {when(o.submittedAt)}</p>
        </div>
        {vs && (
          <p className={`od-vs ${vs.cents < 0 ? "is-below" : "is-above"}`}>
            <strong>{formatBps(vs.bps)}</strong>
            <span>{vs.cents === 0 ? "at" : vs.cents < 0 ? `${formatAud(-vs.cents)} below` : `${formatAud(vs.cents)} above`} your asking price of {formatPrice(d.listing.askingPriceCents!, tx)}</span>
          </p>
        )}
      </header>
      {notice && <p role="status" className="notice">{notice}</p>}

      <div className="od-layout">
        <div className="od-main">
          <section aria-labelledby="od-terms">
            <h2 id="od-terms">Terms</h2>
            <dl className="od-terms">
              <div><dt>Price</dt><dd>{formatPrice(o.priceCents, tx)}</dd></div>
              <div><dt>Deposit</dt><dd>{formatAud(o.depositCents)} <span className="muted">({formatBps(depositBps(o)).replace("+", "")})</span></dd></div>
              <div><dt>Settlement</dt><dd>{o.settlementDays} days</dd></div>
              <div><dt>Buyer checks</dt><dd>{verified.length ? <ul className="od-checks">{verified.map(v => <li key={v}>{v} verified</li>)}</ul> : <span className="muted">Not verified</span>}</dd></div>
            </dl>
            <h3>Conditions</h3>
            {o.conditions.length ? <ul className="chips od-conds">{o.conditions.map(c => <li key={c} className="chip">{c}</li>)}</ul> : <p className="muted">Unconditional offer.</p>}
          </section>

          {n.round > 0 && (
            <section aria-labelledby="od-negotiation">
              <h2 id="od-negotiation">Negotiation</h2>
              <p className="muted">{n.round} counter-offer{n.round === 1 ? "" : "s"} so far (at most {MAX_COUNTER_ROUNDS}).{" "}
                {latest?.status === "agreed" ? "The buyer agreed to your counter. Accept it to finish, or reject." : ""}</p>
              <h3>{latest?.status === "agreed" ? "Terms the buyer agreed to" : "The buyer's terms on the table"}</h3>
              <dl className="od-terms">
                <div><dt>Price</dt><dd>{formatPrice(s.priceCents, tx)}</dd></div>
                <div><dt>Deposit</dt><dd>{formatAud(s.depositCents)}</dd></div>
                <div><dt>Settlement</dt><dd>{s.settlementDays} days</dd></div>
                <div><dt>Conditions</dt><dd>{s.conditions.length ? s.conditions.join("; ") : <span className="muted">None</span>}</dd></div>
              </dl>
              {n.openCounter && <p className="notice">Your counter of {formatPrice(n.openCounter.priceCents, tx)} is waiting for the buyer until {when(n.openCounter.expiresAt)}. If they do not answer by then, the offer expires.</p>}
            </section>
          )}

          <section aria-labelledby="od-timeline">
            <h2 id="od-timeline">Timeline</h2>
            <ol className="od-timeline">
              {n.timeline.map(e => (
                <li key={e.id} className={`od-ev od-ev-${e.type}`}>
                  <span className="od-ev-dot" aria-hidden="true" />
                  <div>
                    <p className="od-ev-title">{describeEvent(e, "owner")}{e.terms && <> at <strong>{formatPrice(e.terms.priceCents, tx)}</strong></>}</p>
                    {e.terms && <p className="od-ev-meta">Deposit {formatAud(e.terms.depositCents)} · {e.terms.settlementDays} days · {e.terms.conditions.length ? e.terms.conditions.join("; ") : "no conditions"}</p>}
                    <p className="od-ev-meta"><time dateTime={e.occurredAt}>{when(e.occurredAt)}</time></p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="od-history">
            <h2 id="od-history">Offers from this buyer</h2>
            {history.length <= 1 ? <p className="muted">This is the buyer&apos;s only offer on this listing so far.</p> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th scope="col">Received</th><th scope="col" className="num">Price</th><th scope="col" className="num">Change</th><th scope="col" className="num">Deposit</th><th scope="col" className="num">Settlement</th><th scope="col">Status</th></tr></thead>
                  <tbody>
                    {history.map(h => (
                      <tr key={h.id} className={h.id === o.id ? "od-current" : undefined} aria-current={h.id === o.id ? "true" : undefined}>
                        <td>{h.id === o.id ? <strong>{day(h.submittedAt)} (this offer)</strong> : <a href={`/listings/${id}/offers/${h.id}`}>{day(h.submittedAt)}</a>}</td>
                        <td className="num">{formatAud(h.priceCents)}</td>
                        <td className={`num ${h.deltaCents === undefined ? "" : h.deltaCents >= 0 ? "od-up" : "od-down"}`}>{h.deltaCents === undefined ? "First offer" : `${h.deltaCents >= 0 ? "+" : "−"}${formatAud(Math.abs(h.deltaCents))}`}</td>
                        <td className="num">{formatAud(h.depositCents)}</td>
                        <td className="num">{h.settlementDays} days</td>
                        <td><span className={`badge badge-${h.status}`}>{label(h.status)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section aria-labelledby="od-messages">
            <div className="od-section-head">
              <h2 id="od-messages">Messages</h2>
              {d.enquiryId && <a className="button secondary" href={`/enquiries/${d.enquiryId}`}>Reply in the chat</a>}
            </div>
            {d.messages.length === 0 ? <p className="muted">No messages with this buyer about this listing.</p> : (
              <ol className="od-messages">
                {d.messages.map((m, i) => (
                  <li key={i} className={`od-msg od-msg-${m.from}`}>
                    <p className="od-msg-meta">{m.from === "buyer" ? "Buyer" : m.from === "owner" ? "Owner" : m.from === "agent" ? "Agent" : "Automatic message"} · <time dateTime={m.at}>{when(m.at)}</time></p>
                    <p className="od-msg-body pre">{m.body}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="od-aside" aria-labelledby="od-decide">
          <section className="panel od-decide">
            <h2 id="od-decide">{d.canDecide ? "Your decision" : "Owner decision"}</h2>
            {!d.canDecide && <p className="muted">Only the owner can accept, reject or counter. As the appointed agent you can review the offer and talk to the buyer.</p>}
            {d.canDecide && !open && <p className="muted">This offer is {label(o.status).toLowerCase()}. No more decisions are needed on it.</p>}
            {d.canDecide && open && allowed.length === 0 && <p className="muted">Waiting for the buyer to answer your counter-offer.</p>}
            {d.canDecide && open && !pending && (
              <div className="od-actions">
                {allowed.map(a => (
                  <button key={a} type="button" className={ACTIONS[a].tone === "primary" ? undefined : ACTIONS[a].tone === "danger" ? "secondary od-danger" : "secondary"} onClick={() => setPending(a)}>{ACTIONS[a].button}</button>
                ))}
              </div>
            )}
            {d.canDecide && pending === "counter" && (
              <div className="confirm-box">
                <p><strong>{ACTIONS.counter.title}</strong></p>
                <p>{ACTIONS.counter.text}</p>
                <CounterForm start={s} busy={busy} submitLabel={ACTIONS.counter.confirm}
                  onSubmit={body => void send(`/api/listings/${id}/offers/${offerId}/counter`, body, "Counter-offer sent to the buyer.")} />
                <div className="actions"><button type="button" className="secondary" onClick={() => setPending(null)} disabled={busy}>Cancel</button></div>
              </div>
            )}
            {d.canDecide && pending && pending !== "counter" && (
              <div className="confirm-box" role="alertdialog" aria-labelledby="od-confirm-title" aria-describedby="od-confirm-text">
                <p id="od-confirm-title"><strong>{ACTIONS[pending].title}</strong></p>
                <dl className="od-confirm-terms">
                  <dt>Price</dt><dd>{formatPrice(s.priceCents, tx)}</dd>
                  <dt>Deposit</dt><dd>{formatAud(s.depositCents)}</dd>
                  <dt>Settlement</dt><dd>{s.settlementDays} days</dd>
                  <dt>Conditions</dt><dd>{s.conditions.length ? s.conditions.join("; ") : "None"}</dd>
                </dl>
                <p id="od-confirm-text">{ACTIONS[pending].text}</p>
                <div className="actions">
                  <button type="button" className={pending === "reject" ? "od-danger-solid" : undefined} onClick={decide} disabled={busy}>{busy ? "Saving..." : ACTIONS[pending].confirm}</button>
                  <button type="button" className="secondary" onClick={() => setPending(null)} disabled={busy}>Cancel</button>
                </div>
              </div>
            )}
            <p className="od-note">The AI never accepts an offer. Deposits are paid to {d.canDecide ? "your" : "the owner's"} solicitor&apos;s trust account, never to this site.</p>
          </section>
          <p className="od-links"><a href={`/listings/${id}/offer-analysis`}>Compare all offers</a> · <a href={`/listings/${id}/mandate`}>Negotiation mandate</a> · <a href={`/listings/${id}/contract-draft`}>Contract draft preview</a></p>
        </aside>
      </div>
    </main>
  );
}
