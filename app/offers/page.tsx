"use client";
import { useEffect, useState } from "react";
import { JSON_HEADERS, fieldStyle } from "../listings/ui";

interface Offer { id: string; priceCents: number; depositCents: number; settlementDays: number; conditions: string[]; status: string; submittedAt: string }
interface Item { offer: Offer; listingTitle: string; role: "buyer" | "owner"; unread: boolean }

const money = (c: number) => (c / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" });

export default function Offers() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    const r = await fetch("/api/offers");
    if (r.status === 401) return setSignedOut(true);
    setItems((await r.json()).items ?? []);
  }
  useEffect(() => { load().catch(() => setError("Could not load offers.")); }, []);

  async function act(id: string, status: string) {
    setError("");
    const r = await fetch(`/api/offers/${id}/status`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ status }) });
    if (!r.ok) setError((await r.json()).error ?? "Could not update the offer.");
    await load();
  }

  if (signedOut) return <main><p role="alert"><a href="/api/auth/google/start">Sign in with Google</a> to see offers.</p></main>;
  return (
    <main style={{ overflowWrap: "anywhere" }}>
      <h1>Offers</h1>
      <p><small>Accepting an offer is not a contract. Contracts are exchanged through solicitors.</small></p>
      {error && <p role="alert">{error}</p>}
      {items === null && !error && <p>Loading...</p>}
      {items && items.length === 0 && <p>No offers yet.</p>}
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 12 }}>
        {items?.map(({ offer: o, listingTitle, role, unread }) => (
          <li key={o.id} style={{ border: "1px solid #8884", borderRadius: 8, padding: 12 }}>
            {unread && <strong>New: </strong>}<strong>{listingTitle}</strong> <small>({role === "owner" ? "offer on your listing" : "your offer"})</small>
            <div>{money(o.priceCents)} · deposit {money(o.depositCents)} · settlement {o.settlementDays} days</div>
            {o.conditions.length > 0 && <div><small>Conditions: {o.conditions.join("; ")}</small></div>}
            <div><small>Status: {o.status.replace("_", " ")} · {new Date(o.submittedAt).toLocaleString("en-AU")}</small></div>
            {role === "owner" && (o.status === "submitted" || o.status === "under_review") && (
              <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                {o.status === "submitted" && <button type="button" style={fieldStyle} onClick={() => act(o.id, "under_review")}>Mark under review</button>}
                <button type="button" style={fieldStyle} onClick={() => act(o.id, "accepted")}>Accept offer</button>
                <button type="button" style={fieldStyle} onClick={() => act(o.id, "rejected")}>Reject offer</button>
              </div>
            )}
            {role === "buyer" && (o.status === "submitted" || o.status === "under_review") && (
              <button type="button" style={{ ...fieldStyle, marginTop: 8 }} onClick={() => act(o.id, "withdrawn")}>Withdraw offer</button>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
