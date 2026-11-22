"use client";
import { useCallback, useEffect, useState } from "react";
import "../../styles/admin.css";
import "../../styles/feeds.css";
import { JSON_HEADERS } from "../../listings/ui";

type Item = { address: string; suburb: string; transactionType: "sale" | "rent"; propertyType: string; priceCents?: number; priceDisplay?: string; bedrooms?: number; bathrooms?: number; parking?: number; headline?: string; soldPriceCents?: number };
type Imported = { connectionId: string; connectionLabel: string; externalId: string; status: string; lastSeenAt: string; draftListingId: string | null; item: Item };

const STATUS: Record<string, [string, string]> = { active: ["Current", "good"], sold: ["Sold", ""], leased: ["Leased", ""], withdrawn: ["Withdrawn", "warn"] };
const dollars = (c: number) => `$${Math.round(c / 100).toLocaleString("en-AU")}`;
const price = (i: Item, status: string) => status === "sold" && i.soldPriceCents !== undefined ? `Sold for ${dollars(i.soldPriceCents)}`
  : i.priceDisplay ?? (i.priceCents !== undefined ? `${dollars(i.priceCents)}${i.transactionType === "rent" ? " per week" : ""}` : "Price not given");
const TYPE: Record<string, string> = { house: "House", unit: "Unit", townhouse: "Townhouse", land: "Land", office: "Office", retail: "Retail", industrial: "Industrial", warehouse: "Warehouse", hospitality: "Hospitality", other: "Other" };

/** Listings imported from the agent's CRM feed. A current one can become a draft; the agent completes and publishes it through the usual checks. */
export default function AgentImports() {
  const [rows, setRows] = useState<Imported[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const r = await fetch("/api/agent/imports").catch(() => null);
    if (!r) return setError("Could not load your imports.");
    if (r.status === 401) return setError("Sign in to see listings imported from your CRM.");
    if (r.status === 403) return setError("CRM imports are for agent accounts.");
    if (!r.ok) return setError("Could not load your imports.");
    setRows((await r.json()).imports ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function draft(x: Imported) {
    setBusy(x.externalId); setError("");
    try {
      const r = await fetch("/api/agent/imports/draft", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ connectionId: x.connectionId, externalId: x.externalId }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? "Could not start the draft."); return; }
      window.location.href = `/listings/${d.listingId}/edit`;
    } finally { setBusy(""); }
  }

  return (
    <main>
      <h1>Imported from your CRM</h1>
      <p className="muted">Listings your agency's CRM sends to us. They stay private until you start a draft, check it and publish it through the usual steps. <a href="/agent/listings">Appointed listings</a> · <a href="/agent/workspace">Workspace</a></p>
      {error && <p role="alert" className="feeds-msg bad">{error}</p>}
      {rows === null && !error && <p className="muted" role="status">Loading…</p>}
      {rows?.length === 0 && <p className="empty">Nothing imported yet. To connect your CRM (VaultRE, Rex, Agentbox, MRI, Box+Dice and others that export REAXML), ask our support team for a feed address.</p>}
      {rows && rows.length > 0 && (
        <ul className="imports">
          {rows.map(x => {
            const [label, tone] = STATUS[x.status] ?? [x.status, ""];
            return (
              <li key={`${x.connectionId}:${x.externalId}`} className="import-card">
                <div className="import-head"><h3>{x.item.headline ?? x.item.address}</h3><span className={`status-pill ${tone}`}>{label}</span></div>
                {x.item.headline && <p>{x.item.address}</p>}
                <p><strong>{price(x.item, x.status)}</strong></p>
                <div className="import-facts">
                  <span>{TYPE[x.item.propertyType] ?? x.item.propertyType}</span>
                  {x.item.bedrooms !== undefined && <span>{x.item.bedrooms} bed</span>}
                  {x.item.bathrooms !== undefined && <span>{x.item.bathrooms} bath</span>}
                  {x.item.parking !== undefined && <span>{x.item.parking} car</span>}
                </div>
                <small className="muted">{x.connectionLabel} · updated {new Date(x.lastSeenAt).toLocaleDateString("en-AU", { dateStyle: "medium" })}</small>
                {(x.draftListingId || x.status === "active") && <div className="row-actions">
                  {x.draftListingId ? <a className="button secondary" href={`/listings/${x.draftListingId}/edit`}>Open draft</a>
                    : x.status === "active" ? <button type="button" disabled={!!busy} onClick={() => draft(x)}>{busy === x.externalId ? "Starting…" : "Start a draft"}</button> : null}
                </div>}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
