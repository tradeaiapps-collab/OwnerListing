"use client";
import { useState } from "react";
import { DEV_HEADERS, fieldStyle } from "../dev-headers";

type Check = { allowed: boolean; reasons: string[] };

export default function NewListing() {
  const [error, setError] = useState("");
  const [draftId, setDraftId] = useState("");
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget).entries());
    setBusy(true);
    setError("");
    setCheck(null);
    try {
      const res = await fetch("/api/listings", { method: "POST", headers: DEV_HEADERS, body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) setError(d.error ?? "Could not save the draft.");
      else setDraftId(d.listing.id);
    } catch {
      setError("Could not save the draft.");
    } finally {
      setBusy(false);
    }
  }

  async function runCheck() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/listings/${draftId}/publish?dryRun=1`, { method: "POST", headers: DEV_HEADERS });
      const d = await res.json();
      if (!res.ok) setError(d.error ?? "Check failed.");
      else setCheck({ allowed: d.decision.allowed, reasons: d.decision.reasons });
    } catch {
      setError("Check failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Create a listing</h1>
      <form onSubmit={onSubmit} style={{ display: "grid", gap: 8 }}>
        <input name="title" placeholder="Title" maxLength={200} required style={fieldStyle} />
        <input name="address" placeholder="Address" maxLength={300} required style={fieldStyle} />
        <select name="jurisdiction" defaultValue="QLD" style={fieldStyle} aria-label="State">
          {["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"].map(j => <option key={j}>{j}</option>)}
        </select>
        <select name="transactionType" defaultValue="sale" style={fieldStyle} aria-label="Sale or rent">
          <option value="sale">Sale</option>
          <option value="rent">Rental</option>
        </select>
        <select name="useClass" defaultValue="residential" style={fieldStyle} aria-label="Use">
          <option value="residential">Residential</option>
          <option value="commercial">Commercial</option>
        </select>
        <select name="propertyType" defaultValue="house" style={fieldStyle} aria-label="Property type">
          {["house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"].map(t => <option key={t}>{t}</option>)}
        </select>
        <button type="submit" disabled={busy} style={fieldStyle}>Save draft</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {draftId && (
        <section>
          <h2>Draft saved</h2>
          <button type="button" disabled={busy} style={fieldStyle} onClick={runCheck}>Check if it can be published</button>
          {check && (
            <div>
              <h3>{check.allowed ? "Can be published" : "Blocked"}</h3>
              <ul>{check.reasons.map(r => <li key={r}>{r}</li>)}</ul>
            </div>
          )}
        </section>
      )}
      <p><a href="/listings">View listings</a></p>
    </main>
  );
}
