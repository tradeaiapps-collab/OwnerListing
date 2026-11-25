"use client";
import { useEffect, useState } from "react";

interface Row { id: string; title: string; address: string; status: string; transactionType: string }

const STATUS_LABELS: Record<string, string> = { draft: "Draft", pending_review: "In review", published: "Published" };

export default function MyListings() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [offersView, setOffersView] = useState(false);
  useEffect(() => {
    const sync = () => setOffersView(window.location.hash === "#offers");
    sync(); window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    fetch("/api/listings/mine")
      .then(async r => {
        if (r.status === 401) { setError("Sign in to see your listings."); return; }
        if (!r.ok) { setError("Could not load your listings."); return; }
        setRows((await r.json()).listings ?? []);
      })
      .catch(() => setError("Could not load your listings."));
  }, []);

  return (
    <main>
      <h1>{offersView ? "Offers" : "My listings"}</h1>
      {offersView && <p className="muted">Offers are reviewed one listing at a time. Choose a listing to see its offers. <a href="/listings/mine">Back to all my listings</a></p>}
      {error && <p role="alert">{error}</p>}
      {!error && rows === null && <p className="muted" role="status">Loading...</p>}
      {rows && offersView && rows.every(r => r.status === "draft") && rows.length > 0 && <p className="empty">Offers appear here once a listing is published.</p>}
      {rows && rows.length === 0 && <p className="empty">You have no listings yet. <a href="/listings/new">Create one</a>.</p>}
      {rows && rows.length > 0 && (
        <ul className="card-list">
          {rows.filter(r => !offersView || r.status !== "draft").map(r => (
            <li key={r.id}>
              <strong>{r.title}</strong>
              <div className="muted">{r.address}</div>
              <div><span className={`badge${r.status === "published" ? " badge-accepted" : ""}`}>{STATUS_LABELS[r.status] ?? r.status}</span><span className="badge">{r.transactionType === "sale" ? "For sale" : "For rent"}</span></div>
              {offersView && <div><a className="button" href={`/listings/${r.id}/offers`}>View offers</a></div>}
              {!offersView && r.status === "draft" && <div><a href={`/listings/${r.id}/edit`}>Edit this draft</a> · <a href={`/listings/${r.id}/photos`}>Photos</a> · <a href={`/listings/${r.id}/checkout`}>Pay and publish</a> · <a href={`/listings/${r.id}/agent`}>Agent</a> · <a href={`/listings/${r.id}/signing`}>Documents</a></div>}
              {!offersView && r.status !== "draft" && <div><a href={`/listings/${r.id}/photos`}>Photos</a> · <a href={`/listings/${r.id}/offers`}>Offers</a> · <a href={`/listings/${r.id}/mandate`}>Negotiation mandate</a> · <a href={`/listings/${r.id}/agent`}>Agent</a> · <a href={`/listings/${r.id}/signing`}>Documents</a> · <a href={`/listings/${r.id}/syndication`}>Other portals</a></div>}
              {!offersView && <div><a href={`/listings/${r.id}/returns`}>Returns calculator</a></div>}
            </li>
          ))}
        </ul>
      )}
      <p><a className="button" href="/listings/new">Create a listing</a></p>
    </main>
  );
}
