"use client";
import { useEffect, useState } from "react";
import "../../styles/enquiries.css";

type Item = { id: string; projectTitle: string; role: "investor" | "owner"; contractStatus: string };

export default function Conversations() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void fetch("/api/investments/threads").then(async r => {
      if (r.ok) setItems((await r.json()).items ?? []); else setError(r.status === 401 ? "Sign in to see your conversations." : "Could not load.");
    }).catch(() => setError("Could not load."));
  }, []);
  return (
    <main>
      <h1>Investor conversations</h1>
      <p className="muted">All messages stay on the platform. Messages are permanent and cannot be deleted.</p>
      {error && <p role="alert">{error}</p>}
      {items === null && !error && <p className="muted" role="status">Loading…</p>}
      {items?.length === 0 && <p className="empty">No conversations yet.</p>}
      <ul className="card-list">
        {items?.map(i => (
          <li key={i.id} className="enq-row">
            <a href={`/investments/threads/${i.id}`}>{i.projectTitle} <small className="muted">({i.role === "owner" ? "an investor on your project" : "you expressed interest"})</small></a>
            {i.contractStatus !== "none" && <span className="inv-status">contract {i.contractStatus}</span>}
          </li>
        ))}
      </ul>
    </main>
  );
}
