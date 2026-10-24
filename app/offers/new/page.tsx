"use client";
import { useEffect, useState } from "react";
import { JSON_HEADERS, fieldStyle } from "../../listings/ui";

const NOTICE =
  "This form submits an offer only. No contract exists until contracts are exchanged. " +
  "Speak to your solicitor before you make an offer, and do not send money until they advise you.";

const cents = (v: string) => Math.round(Number(v) * 100);

export default function NewOffer() {
  const [token, setToken] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token") ?? "";
    setToken(t);
    fetch(`/api/offers/link?token=${encodeURIComponent(t)}`).then(async r => {
      if (r.status === 401) return setSignedOut(true);
      const d = await r.json();
      if (r.ok) setTitle(d.listingTitle);
      else setError(d.error ?? "This offer link is not valid.");
    }).catch(() => setError("Could not check the offer link."));
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const price = cents(String(f.get("price")));
    const deposit = cents(String(f.get("deposit") || "0"));
    const days = Number(f.get("days"));
    if (!Number.isFinite(price) || !Number.isFinite(deposit) || !Number.isFinite(days)) return setError("Enter valid numbers.");
    const conditions = String(f.get("conditions") ?? "").split("\n").map(c => c.trim()).filter(Boolean);
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/offers", {
        method: "POST", headers: JSON_HEADERS,
        body: JSON.stringify({ token, priceCents: price, depositCents: deposit, settlementDays: days, conditions, confirmedFinal: f.get("final") === "on" })
      });
      if (res.ok) setDone(true);
      else setError((await res.json()).error ?? "Could not submit the offer.");
    } catch {
      setError("Could not submit the offer.");
    } finally {
      setBusy(false);
    }
  }

  if (signedOut) return <main><p role="alert"><a href="/api/auth/google/start">Sign in with Google</a>, then open your offer link again.</p></main>;
  if (done) return <main><h1>Offer submitted</h1><p>The owner has been notified of your formal offer. This is not a contract.</p><p><a href="/offers">Your offers</a></p></main>;
  return (
    <main style={{ overflowWrap: "anywhere" }}>
      <h1>Make a formal offer</h1>
      {title && <p><strong>{title}</strong></p>}
      <p>{NOTICE}</p>
      {error && <p role="alert">{error}</p>}
      {title && (
        <form onSubmit={onSubmit} style={{ display: "grid", gap: 8 }}>
          <input name="price" type="number" min="1" step="0.01" placeholder="Offer amount (AUD)" required style={fieldStyle} />
          <input name="deposit" type="number" min="0" step="0.01" placeholder="Deposit (AUD)" style={fieldStyle} />
          <input name="days" type="number" min="1" max="365" placeholder="Settlement (days)" required style={fieldStyle} />
          <textarea name="conditions" rows={4} placeholder="Conditions, one per line (optional)" style={fieldStyle} />
          <label><input name="final" type="checkbox" required /> This is my formal, final offer.</label>
          <button type="submit" disabled={busy} style={fieldStyle}>Submit offer</button>
        </form>
      )}
    </main>
  );
}
