"use client";
import { useEffect, useState } from "react";
import { formatPrice } from "../../../src/domain/listing-details";
import type { SavedListingView } from "../../../src/domain/saved-listings";

export default function SavedListings() {
  const [items, setItems] = useState<SavedListingView[]>([]);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/buyer/saved-listings")
      .then(async r => {
        if (r.status === 401) { setSignedOut(true); return; }
        const d = await r.json();
        if (!r.ok) setError(d.error ?? "Could not load your saved homes.");
        else setItems(d.listings ?? []);
      })
      .catch(() => setError("Could not load your saved homes."));
  }, []);

  async function remove(id: string) {
    setError("");
    try {
      const r = await fetch(`/api/buyer/saved-listings/${id}`, { method: "DELETE" });
      if (r.ok) setItems(s => s.filter(x => x.listingId !== id));
      else setError("Could not remove the home.");
    } catch {
      setError("Could not remove the home.");
    }
  }

  return (
    <main>
      <h1>Saved homes</h1>
      {signedOut && <p role="alert"><a href="/api/auth/google/start?as=buyer&next=/buyer/saved-listings">Sign in with Google</a> to see your saved homes.</p>}
      {error && <p role="alert">{error}</p>}
      {!signedOut && (items.length === 0 ? <p className="empty">No saved homes yet.</p> : (
        <ul className="card-list">
          {items.map(l => (
            <li key={l.listingId}>
              <a href={`/listings/${l.listingId}`}>{l.title}</a>
              {l.suburb ? ` · ${l.suburb}` : ""}
              {l.priceCents !== undefined ? ` · ${formatPrice(l.priceCents, l.transactionType)}` : ""}
              {l.bedrooms !== undefined ? ` · ${l.bedrooms} bed` : ""}{" "}
              <button type="button" className="secondary" onClick={() => remove(l.listingId)} aria-label={`Remove ${l.title} from saved homes`}>Remove</button>
            </li>
          ))}
        </ul>
      ))}
      <p><a href="/listings">View listings</a> · <a href="/buyer/saved-searches">Saved searches</a></p>
    </main>
  );
}
