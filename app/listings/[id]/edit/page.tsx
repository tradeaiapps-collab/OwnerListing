"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { BondPathwayField, ListingFields, type BondState, type ListingDefaults } from "../../fields";
import { JSON_HEADERS, listingFormBody } from "../../ui";
import { PhotoManager } from "../../photo-manager";

type Loaded = ListingDefaults & { id: string; status: string };
type Check = { allowed: boolean; reasons: string[] };
type Suggestion = { state: "ready"; text: string; label: string } | { state: "unavailable"; message: string };

/** Owner asks the self-hosted AI for a draft description. Shown as text to copy and edit; never saved or published from here. */
function SuggestDescription({ id }: { id: string }) {
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Suggestion | null>(null);
  const [error, setError] = useState("");
  async function ask() {
    setBusy(true); setError(""); setResult(null);
    try {
      const res = await fetch(`/api/listings/${id}/description-suggestion`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ notes }) });
      const d = await res.json();
      if (res.ok) setResult(d); else setError(d.error ?? "Could not get a suggestion.");
    } catch { setError("Could not get a suggestion."); } finally { setBusy(false); }
  }
  return (
    <section className="panel">
      <h3>Suggest description</h3>
      <label>Notes for the AI (optional, for example what you love about the home)
        <textarea value={notes} maxLength={1000} rows={3} onChange={e => setNotes(e.target.value)} />
      </label>
      <button type="button" className="secondary" disabled={busy} onClick={ask}>{busy ? "Working..." : "Suggest description"}</button>
      {result?.state === "ready" && (
        <div>
          <p className="muted"><strong>{result.label}.</strong> Check every fact and change anything that is not right.</p>
          <textarea readOnly value={result.text} rows={8} />
        </div>
      )}
      {result?.state === "unavailable" && <p className="muted" role="status">{result.message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export default function EditListing() {
  const { id } = useParams<{ id: string }>();
  const [listing, setListing] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  const [bond, setBond] = useState("");
  const [bondState, setBondState] = useState<BondState>("idle");

  useEffect(() => {
    setListing(null);
    setLoadError("");
    fetch(`/api/listings/${id}`)
      .then(async r => {
        const d = await r.json();
        if (r.ok) {
          setListing(d.listing);
          setBond(typeof d.rentalBondPathway === "string" ? d.rentalBondPathway : "");
        }
        else setLoadError(r.status === 404 ? "Listing not found. If it is your draft, sign in first." : d.error ?? "Could not load the listing.");
      })
      .catch(() => setLoadError("Could not load the listing."));
  }, [id]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = listingFormBody(new FormData(e.currentTarget));
    if ("error" in parsed) { setError(parsed.error); return; }
    const body = parsed.body;
    setBusy(true);
    setError("");
    setSaved(false);
    setCheck(null);
    try {
      const res = await fetch(`/api/listings/${id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = await res.json();
      if (res.status === 401) setError("Sign in to edit this draft.");
      else if (!res.ok) setError(d.error ?? "Could not save the draft.");
      else {
        setListing(d.listing);
        setSaved(true);
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
      const res = await fetch(`/api/listings/${id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ rentalBondPathway: value }) });
      setBondState(res.ok ? "saved" : "error");
    } catch {
      setBondState("error");
    }
  }

  async function runCheck() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/listings/${id}/publish?dryRun=1`, { method: "POST", headers: JSON_HEADERS });
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
    <main className="narrow">
      <h1>Edit draft</h1>
      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && !listing && <p className="muted" role="status">Loading...</p>}
      {listing && listing.status !== "draft" && <p role="alert">Only a draft can be edited.</p>}
      {listing && listing.status === "draft" && (
        <>
          <form className="stack" onSubmit={onSubmit}>
            <ListingFields defaults={listing} />
            <div className="form-bar"><button type="submit" disabled={busy}>Save changes</button></div>
          </form>
          {saved && <p role="status">Changes saved.</p>}
          {error && <p role="alert">{error}</p>}
          <PhotoManager listingId={listing.id} />
          <section className="panel">
            {listing.transactionType === "rent" && <BondPathwayField value={bond} state={bondState} onChange={saveBond} />}
            <button type="button" className="secondary" disabled={busy} onClick={runCheck}>Check if it can be published</button>
            {check && (
              <div>
                <h3>{check.allowed ? "Can be published" : "Blocked"}</h3>
                <ul className="plain-list">{check.reasons.map(r => <li key={r}>{r}</li>)}</ul>
              </div>
            )}
          </section>
          <SuggestDescription id={id} />
        </>
      )}
      <p><a className="button secondary" href="/listings/mine">Back to my listings</a></p>
    </main>
  );
}
