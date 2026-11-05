"use client";
import { useEffect, useState } from "react";
import { OptimizationPanel } from "../../listings/optimization-panel";

interface Mine { id: string; title: string; address: string; status?: string }

/** Elena's suggestions for one of the signed-in owner's listings. */
export default function ListingOptimizationPage() {
  const [listings, setListings] = useState<Mine[]>([]);
  const [id, setId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    fetch("/api/listings/mine").then(async r => {
      if (r.status === 401) { setSignedOut(true); return; }
      const d = await r.json().catch(() => ({})) as { listings?: Mine[] };
      const all = d.listings ?? [];
      setListings(all);
      const want = new URLSearchParams(window.location.search).get("listing");
      setId((all.find(l => l.id === want) ?? all[0])?.id ?? "");
    }).catch(() => setError("Could not load your listings.")).finally(() => setLoaded(true));
  }, []);

  return (
    <main className="mk">
      <h1>Listing optimization</h1>
      <p className="muted">Elena checks your photos, description and price, and suggests what to change, with a rough idea of the difference it could make. You decide what to do.</p>
      {signedOut && <p role="alert">Sign in to see suggestions for your listing. <a href="/login">Sign in</a></p>}
      {error && <p role="alert">{error}</p>}
      {loaded && !signedOut && !error && listings.length === 0 && <p className="empty">You have no listings yet. <a href="/listings/new">Create a listing</a></p>}
      {listings.length > 0 && (
        <>
          <div className="panel">
            <label>Listing<select value={id} onChange={e => setId(e.target.value)}>{listings.map(l => <option key={l.id} value={l.id}>{l.title || l.address}</option>)}</select></label>
          </div>
          {id && <OptimizationPanel key={id} listingId={id} />}
        </>
      )}
    </main>
  );
}
