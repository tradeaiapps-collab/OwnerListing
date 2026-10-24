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
      {!error && rows === null && <p>Loading...</p>}
      {rows && rows.length === 0 && <p>You have no listings yet. <a href="/listings/new">Create one</a>.</p>}
      {rows && rows.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 12 }}>
          {rows.map(r => (
            <li key={r.id} style={{ border: "1px solid #8884", borderRadius: 8, padding: 12, overflowWrap: "anywhere" }}>
              <strong>{r.title}</strong>
              <div>{r.address}</div>
              <small>{STATUS_LABELS[r.status] ?? r.status} · {r.transactionType === "sale" ? "Sale" : "Rent"}</small>
              {r.status === "draft" && <div><a href={`/listings/${r.id}/edit`}>Edit this draft</a></div>}
            </li>
          ))}
        </ul>
      )}
      <p><a href="/listings/new">Create a listing</a></p>
    </main>
  );
}
