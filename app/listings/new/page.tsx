"use client";
import { useState } from "react";
import { BOND_PATHWAY_LABELS, JSON_HEADERS, fieldStyle } from "../ui";

type Check = { allowed: boolean; reasons: string[] };

export default function NewListing() {
  const [error, setError] = useState("");
  const [draftId, setDraftId] = useState("");
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [isRent, setIsRent] = useState(false);
  const [bond, setBond] = useState("");
  const [bondState, setBondState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget).entries());
    setBusy(true);
    setError("");
    setCheck(null);
    setBond("");
    setBondState("idle");
    try {
      const res = await fetch("/api/listings", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = await res.json();
      if (res.status === 401) setSignedOut(true);
      else if (!res.ok) setError(d.error ?? "Could not save the draft.");
      else {
        setDraftId(d.listing.id);
        setIsRent(d.listing.transactionType === "rent");
      }
    } catch {
      setError("Could not save the draft.");
    } finally {
      setBusy(false);
    }
  }

  async function saveBond(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    setBond(value);
    setBondState("saving");
    setCheck(null);
    try {
      const res = await fetch(`/api/listings/${draftId}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ rentalBondPathway: value }) });
      setBondState(res.ok ? "saved" : "error");
    } catch {
      setBondState("error");
    }
  }

  async function runCheck() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/listings/${draftId}/publish?dryRun=1`, { method: "POST", headers: JSON_HEADERS });
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
      {signedOut && <p role="alert"><a href="/api/auth/google/start">Sign in with Google</a> to save a listing.</p>}
      {error && <p role="alert">{error}</p>}
      {draftId && (
        <section>
          <h2>Draft saved</h2>
          {isRent && (
            <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
              <label htmlFor="bond-pathway">Where will the rental bond be held? The platform never holds it.</label>
              <select id="bond-pathway" value={bond} onChange={saveBond} disabled={bondState === "saving"} style={fieldStyle}>
                <option value="" disabled>Choose an option</option>
                {Object.entries(BOND_PATHWAY_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              {bondState === "saving" && <small role="status">Saving...</small>}
              {bondState === "saved" && <small role="status">Bond arrangement saved.</small>}
              {bondState === "error" && <small role="alert">Could not save the bond arrangement. Try again.</small>}
            </div>
          )}
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
