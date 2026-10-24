"use client";
import { useState } from "react";
import { BondPathwayField, ListingFields, type BondState } from "../fields";
import { JSON_HEADERS, listingFormBody } from "../ui";

type Check = { allowed: boolean; reasons: string[] };

export default function NewListing() {
  const [error, setError] = useState("");
  const [draftId, setDraftId] = useState("");
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [isRent, setIsRent] = useState(false);
  const [bond, setBond] = useState("");
  const [bondState, setBondState] = useState<BondState>("idle");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = listingFormBody(new FormData(e.currentTarget));
    if ("error" in parsed) { setError(parsed.error); return; }
    const body = parsed.body;
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
      <form className="stack" onSubmit={onSubmit}>
        <ListingFields />
        <button type="submit" disabled={busy}>Save draft</button>
      </form>
      {signedOut && <p role="alert"><a href="/api/auth/google/start">Sign in with Google</a> to save a listing.</p>}
      {error && <p role="alert">{error}</p>}
      {draftId && (
        <section role="status">
          <h2>Draft saved</h2>
          <p><a href={`/listings/${draftId}/edit`}>Edit this draft</a></p>
          {isRent && (
            <BondPathwayField value={bond} state={bondState} onChange={saveBond} />
          )}
          <button type="button" className="secondary" disabled={busy} onClick={runCheck}>Check if it can be published</button>
          {check && (
            <div>
              <h3>{check.allowed ? "Can be published" : "Blocked"}</h3>
              <ul className="plain-list">{check.reasons.map(r => <li key={r}>{r}</li>)}</ul>
            </div>
          )}
        </section>
      )}
      <p><a className="button secondary" href="/listings">View listings</a></p>
    </main>
  );
}
