"use client";
import { useEffect, useState } from "react";
import "../../styles/enquiries.css";

type Item = { listingId: string; title: string; jurisdiction: string; status: string; enquiries: number; unread: number };

/** Listings the signed-in agent is appointed to, with unread enquiry counts. Read-only. */
export default function AgentListings() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/agent/listings");
        if (r.status === 401) return setError("Sign in to see your appointed listings.");
        const body = (await r.json().catch(() => ({}))) as { listings?: Item[]; error?: string };
        if (!r.ok) return setError(body.error ?? "Could not load appointed listings.");
        setItems(body.listings ?? []);
      } catch {
        setError("Could not load appointed listings.");
      }
    })();
  }, []);

  return (
    <main>
      <h1>Appointed listings</h1>
      <p><a href="/agent/workspace">Workspace: performance, leads and clients</a> · <a href="/agent/appointments">Invitations and appointments</a> · <a href="/agent/team">Team</a> · <a href="/agent/imports">Imported from your CRM</a> · <a href="/agent/leads">My leads</a></p>
      {error && <p role="alert">{error}</p>}
      {items === null && !error && <p className="muted" role="status">Loading…</p>}
      {items && items.length === 0 && <p className="empty">You have no active appointments.</p>}
      <ul className="card-list">
        {items?.map(i => (
          <li key={i.listingId} className="enq-row">
            <a href={`/listings/${i.listingId}`}>{i.title} <small className="muted">({i.jurisdiction}, {i.status}, {i.enquiries} {i.enquiries === 1 ? "enquiry" : "enquiries"})</small></a>
            {i.unread > 0 && <span className="enq-badge" aria-label={`${i.unread} unread`}>{i.unread}</span>}
            <small><a href={`/listings/${i.listingId}/offers`}>Offers</a> · <a href={`/listings/${i.listingId}/mandate`}>Mandate</a></small>
          </li>
        ))}
      </ul>
    </main>
  );
}
