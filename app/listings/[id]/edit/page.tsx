"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { BondPathwayField, ListingFields, type BondState, type ListingDefaults } from "../../fields";
import { JSON_HEADERS, fieldStyle } from "../../ui";

type Loaded = ListingDefaults & { id: string; status: string };
type Check = { allowed: boolean; reasons: string[] };

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
        if (r.ok) setListing(d.listing);
        else setLoadError(r.status === 404 ? "Listing not found. If it is your draft, sign in first." : d.error ?? "Could not load the listing.");
      })
      .catch(() => setLoadError("Could not load the listing."));
  }, [id]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget).entries());
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
    <main>
      <h1>Edit draft</h1>
      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && !listing && <p>Loading...</p>}
      {listing && listing.status !== "draft" && <p role="alert">Only a draft can be edited.</p>}
      {listing && listing.status === "draft" && (
        <>
          <form onSubmit={onSubmit} style={{ display: "grid", gap: 8 }}>
            <ListingFields defaults={listing} />
            <button type="submit" disabled={busy} style={fieldStyle}>Save changes</button>
          </form>
          {saved && <p role="status">Changes saved.</p>}
          {error && <p role="alert">{error}</p>}
          <section>
            {listing.transactionType === "rent" && <BondPathwayField value={bond} state={bondState} onChange={saveBond} />}
            <button type="button" disabled={busy} style={fieldStyle} onClick={runCheck}>Check if it can be published</button>
            {check && (
              <div>
                <h3>{check.allowed ? "Can be published" : "Blocked"}</h3>
                <ul>{check.reasons.map(r => <li key={r}>{r}</li>)}</ul>
              </div>
            )}
          </section>
        </>
      )}
      <p><a href="/listings">View listings</a></p>
    </main>
  );
}
