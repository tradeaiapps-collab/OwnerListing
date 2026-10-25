"use client";
import { useEffect, useState } from "react";

interface Row { id: string; title: string; address: string; status: string; transactionType: string }

const STATUS_LABELS: Record<string, string> = { draft: "Draft", pending_review: "In review", published: "Published" };

export default function MyListings() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");

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
      <h1>My listings</h1>
      {error && <p role="alert">{error}</p>}
      {!error && rows === null && <p className="muted" role="status">Loading...</p>}
      {rows && rows.length === 0 && <p className="empty">You have no listings yet. <a href="/listings/new">Create one</a>.</p>}
      {rows && rows.length > 0 && (
        <ul className="card-list">
          {rows.map(r => (
            <li key={r.id}>
              <strong>{r.title}</strong>
              <div className="muted">{r.address}</div>
              <div><span className={`badge${r.status === "published" ? " badge-accepted" : ""}`}>{STATUS_LABELS[r.status] ?? r.status}</span><span className="badge">{r.transactionType === "sale" ? "For sale" : "For rent"}</span></div>
              {r.status === "draft" && <div><a href={`/listings/${r.id}/edit`}>Edit this draft</a> · <a href={`/listings/${r.id}/photos`}>Photos</a> · <a href={`/listings/${r.id}/checkout`}>Pay and publish</a></div>}
              {r.status !== "draft" && <div><a href={`/listings/${r.id}/photos`}>Photos</a></div>}
            </li>
          ))}
        </ul>
      )}
      <p><a className="button" href="/listings/new">Create a listing</a></p>
    </main>
  );
}
