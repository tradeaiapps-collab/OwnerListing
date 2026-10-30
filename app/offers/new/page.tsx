"use client";
import { useEffect, useState } from "react";
import { OFFER_FORM_NOTICE } from "../../../src/domain/offer-intake";
import { dollarsToCents, parseConditionLines, readOfferToken } from "../../../src/domain/offer-form";
import { JSON_HEADERS } from "../../listings/ui";
import "../../styles/offers.css";

type Listing = { id: string; title: string; address: string; transactionType: string };
type Phase = "loading" | "no_link" | "signed_out" | "ready" | "invalid" | "expired" | "used" | "not_verified" | "done";

const STASH = "offer-link";
const dollars = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);

/** Where the link ends up, from the API's message. The API does not use separate codes for these cases. */
function linkProblem(status: number, message: string): Phase | undefined {
  if (status === 403) return "not_verified";
  if (status === 409 || /already been used/i.test(message)) return "used";
  if (/expired/i.test(message)) return "expired";
  if (/not valid|different/i.test(message)) return "invalid";
  return undefined;
}

/**
 * Buyer offer form, opened from the single-use link in the chat: /offers/new?listing=ID#token=TOKEN.
 * The token is read from the fragment (never sent to a server until submit) and the buyer must be signed in as the
 * buyer the link was issued to. This page only submits an offer: it never accepts or counters anything.
 */
export default function NewOffer() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [listingId, setListingId] = useState("");
  const [token, setToken] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [amount, setAmount] = useState("");
  const [deposit, setDeposit] = useState("");
  const [days, setDays] = useState("42");
  const [conditions, setConditions] = useState("");
  const [final, setFinal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let lid = new URLSearchParams(window.location.search).get("listing") ?? "";
    let tok = readOfferToken(window.location.hash, window.location.search);
    try {
      // The sign-in redirect drops the fragment, so the link is kept for this tab only until the buyer returns.
      if (lid && tok) sessionStorage.setItem(STASH, JSON.stringify({ lid, tok }));
      else {
        const s = JSON.parse(sessionStorage.getItem(STASH) ?? "null") as { lid?: string; tok?: string } | null;
        lid = s?.lid ?? "";
        tok = s?.tok ?? "";
      }
    } catch { /* storage unavailable: the link must be opened again after sign-in */ }
    if (!lid || !tok) { setPhase("no_link"); return; }
    // Keep the token out of the address bar, history and referrers.
    window.history.replaceState(null, "", `/offers/new?listing=${encodeURIComponent(lid)}`);
    setListingId(lid);
    setToken(tok);
    Promise.all([fetch("/api/auth/me"), fetch(`/api/listings/${encodeURIComponent(lid)}`)])
      .then(async ([me, l]) => {
        const u = (await me.json().catch(() => ({}))) as { user?: { userType: string } | null };
        if (l.ok) setListing(((await l.json()) as { listing: Listing }).listing);
        if (!u.user) setPhase("signed_out");
        else if (!l.ok) setPhase("invalid");
        else setPhase("ready");
      })
      .catch(() => { setError("Could not load this page. Check your connection and try again."); setPhase("ready"); });
  }, []);

  const priceCents = dollarsToCents(amount);
  const depositCents = deposit.trim() === "" ? 0 : dollarsToCents(deposit);
  const settlement = Number(days);
  const problems = [
    priceCents === undefined || priceCents <= 0 ? "Enter the amount as dollars, for example 850000." : "",
    depositCents === undefined || (priceCents !== undefined && depositCents > priceCents) ? "Deposit must be a dollar amount that is not more than your offer." : "",
    !Number.isInteger(settlement) || settlement < 1 || settlement > 365 ? "Settlement must be 1 to 365 days." : "",
    parseConditionLines(conditions).length > 10 ? "Use at most 10 conditions." : ""
  ].filter(Boolean);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!final || problems.length > 0) { setError(!final ? "Tick the box to confirm this is your formal, final offer." : problems[0] ?? ""); return; }
    setBusy(true);
    const r = await fetch(`/api/listings/${encodeURIComponent(listingId)}/offers`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token, priceCents, depositCents, settlementDays: settlement, conditions: parseConditionLines(conditions), confirmedFinal: true })
    }).catch(() => null);
    setBusy(false);
    if (!r) { setError("Could not send your offer. Check your connection and try again."); return; }
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    if (r.ok) { try { sessionStorage.removeItem(STASH); } catch { /* ignore */ } setPhase("done"); return; }
    if (r.status === 401) { setPhase("signed_out"); return; }
    const p = linkProblem(r.status, d.error ?? "");
    if (p) { setPhase(p); return; }
    setError(r.status === 429 ? "Too many attempts. Try again in a few minutes." : d.error ?? "Could not send your offer.");
  };

  if (phase === "loading") return <main><p className="muted" role="status">Loading…</p></main>;

  const stop = (title: string, body: React.ReactNode) => (
    <main><h1>{title}</h1><p role="alert">{body}</p></main>
  );
  if (phase === "no_link") return stop("Offer link needed", "Open the secure link from the chat. Offers can only be made through that link.");
  if (phase === "invalid") return stop("This link is not valid", "It may be for a different buyer or property. Ask for a new link in the chat.");
  if (phase === "expired") return stop("This link has expired", "Links last 24 hours. Ask for a new one in the chat.");
  if (phase === "used") return stop("This link has already been used", "Each link works once. If you need to change your offer, ask for a new link in the chat.");
  if (phase === "signed_out") {
    return (
      <main>
        <h1>Sign in to make an offer</h1>
        <p>Sign in as the buyer this link was sent to. Then open the link again if this page does not come back.</p>
        <p><a className="button" href="/login?as=buyer">Sign in as buyer</a></p>
      </main>
    );
  }
  if (phase === "not_verified") {
    return (
      <main>
        <h1>Verify your identity first</h1>
        <p role="alert">We cannot take an offer from you yet. Buyers must complete the identity check before making an offer.</p>
        <p><a className="button" href="/buyer/verification">Go to verification</a></p>
        <p className="muted">When you finish, open your offer link again.</p>
      </main>
    );
  }
  if (phase === "done") {
    return (
      <main>
        <h1>Offer sent</h1>
        <p role="status">The owner has your formal offer of {priceCents !== undefined ? dollars(priceCents) : "the amount entered"}. They will decide; you will be told the outcome.</p>
        <p className="notice"><strong>An offer is not a contract</strong>{OFFER_FORM_NOTICE}</p>
        <p><a href="/offers">See my offers</a> · <a href="/listings">Back to listings</a></p>
      </main>
    );
  }

  return (
    <main>
      <h1>Make a formal offer</h1>
      {listing ? <section className="panel"><strong>{listing.title}</strong><div>{listing.address}</div><small className="muted">{listing.transactionType === "sale" ? "For sale" : "For rent"}</small></section> : null}
      <p className="notice"><strong>An offer is not a contract</strong>{OFFER_FORM_NOTICE}</p>
      <form className="offer-form" onSubmit={submit} noValidate>
        <label>
          {listing?.transactionType === "rent" ? "Rent offered per period (AUD)" : "Your offer (AUD)"}
          <input inputMode="decimal" autoComplete="off" placeholder="850000" value={amount} onChange={e => setAmount(e.target.value)} required />
          {priceCents !== undefined && priceCents > 0 ? <span className="hint">{dollars(priceCents)}</span> : null}
        </label>
        <label>
          Deposit (AUD)
          <input inputMode="decimal" autoComplete="off" placeholder="0" value={deposit} onChange={e => setDeposit(e.target.value)} />
          <span className="hint">Paid to the solicitor&apos;s trust account, never to this site.</span>
        </label>
        <label>
          Settlement (days)
          <input inputMode="numeric" value={days} onChange={e => setDays(e.target.value)} required />
        </label>
        <label>
          Conditions
          <textarea value={conditions} onChange={e => setConditions(e.target.value)} placeholder="One condition per line, for example: Subject to finance" />
          <span className="hint">Up to 10, one per line. Leave blank for none.</span>
        </label>
        <div className="confirm-box">
          <label className="check">
            <input type="checkbox" checked={final} onChange={e => setFinal(e.target.checked)} />
            <span>This is my formal, final offer</span>
          </label>
        </div>
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" disabled={busy || !final}>{busy ? "Sending…" : "Send formal offer"}</button>
      </form>
    </main>
  );
}
