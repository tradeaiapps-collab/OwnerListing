"use client";
import { useCallback, useEffect, useState } from "react";
import type { Impact, SuggestionType } from "../../src/domain/listing-optimization";
import { TYPE_LABEL } from "../../src/domain/listing-optimization";
import "../styles/listing-optimization.css";

interface Outcome { days: number; enquiriesBefore: number; enquiriesAfter: number; offersBefore: number; offersAfter: number }
interface Item { id: string; type: SuggestionType; description: string; impact: Impact; status: "open" | "implemented" | "dismissed" | "outdated"; outcome: Outcome | null }
const range = (r: { low: number; high: number }) => (r.low === r.high ? `${r.low}%` : `${r.low}–${r.high}%`);

/**
 * Elena's suggestions for one listing, for its owner only. The API answers 404 to everyone else and while the feature is off, so the
 * card renders nothing then (`quiet`) or a short message (the full page).
 */
export function OptimizationPanel({ listingId, quiet = false }: { listingId: string; quiet?: boolean }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [note, setNote] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "hidden" | "error">("loading");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const r = await fetch(`/api/listings/${listingId}/optimization`);
      if (!r.ok) { setState(r.status === 404 || r.status === 401 ? "hidden" : "error"); return; }
      const d = await r.json() as { suggestions: Item[]; note: string };
      setItems(d.suggestions); setNote(d.note); setState("ready");
    } catch { setState("error"); }
  }, [listingId]);
  useEffect(() => { void load(); }, [load]);

  async function answer(id: string, status: "implemented" | "dismissed" | "open") {
    setBusy(id);
    try {
      const r = await fetch(`/api/listings/${listingId}/optimization`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ suggestionId: id, status }) });
      if (r.ok) setItems(((await r.json()) as { suggestions: Item[] }).suggestions);
      else setState("error");
    } catch { setState("error"); } finally { setBusy(""); }
  }

  if (state === "hidden") return quiet ? null : <p className="muted">Listing suggestions are not available for this listing right now.</p>;
  if (state === "loading") return <section className="panel lo-panel" aria-label="Listing suggestions" aria-busy="true"><h2>Make your listing work harder</h2><p className="muted" role="status">Elena is checking your listing…</p></section>;
  if (state === "error") return <section className="panel lo-panel" aria-label="Listing suggestions"><h2>Make your listing work harder</h2><p role="alert">Suggestions could not be loaded. <button type="button" onClick={() => void load()}>Try again</button></p></section>;
  const shown = (items ?? []).filter(i => i.status !== "outdated");
  const open = shown.filter(i => i.status === "open"), rest = shown.filter(i => i.status !== "open");
  return (
    <section className="panel lo-panel" aria-label="Listing suggestions">
      <h2>Make your listing work harder</h2>
      {open.length === 0 && <p>{shown.length === 0 ? "Elena found nothing to improve. Your listing covers the basics." : "You have dealt with every suggestion. Well done."}</p>}
      <ul className="lo-list">
        {[...open, ...rest].map(i => (
          <li key={i.id} className={`lo-item ${i.status === "implemented" ? "is-done" : i.status === "dismissed" ? "is-dismissed" : ""}`}>
            <h3>{i.status === "implemented" && <span className="lo-tag">✓ Done · </span>}{i.status === "dismissed" && <span>Dismissed · </span>}{TYPE_LABEL[i.type]}</h3>
            <p>{i.description}</p>
            <ul className="lo-impact" aria-label="Estimated impact">
              <li>Views +{range(i.impact.viewsPercent)}</li><li>Offers +{range(i.impact.offersPercent)}</li>
            </ul>
            {i.outcome && <p className="lo-note">In the {i.outcome.days} days after you made this change: {i.outcome.enquiriesAfter} enquir{i.outcome.enquiriesAfter === 1 ? "y" : "ies"} and {i.outcome.offersAfter} offer{i.outcome.offersAfter === 1 ? "" : "s"}, against {i.outcome.enquiriesBefore} and {i.outcome.offersBefore} in the {i.outcome.days} days before.</p>}
            <div className="lo-actions">
              {i.status === "open" ? (
                <>
                  <button type="button" disabled={busy === i.id} onClick={() => void answer(i.id, "implemented")}>I did this</button>
                  <button type="button" className="secondary" disabled={busy === i.id} onClick={() => void answer(i.id, "dismissed")}>Not for me</button>
                </>
              ) : <button type="button" className="secondary" disabled={busy === i.id} onClick={() => void answer(i.id, "open")}>Reopen</button>}
            </div>
          </li>
        ))}
      </ul>
      <p className="lo-note">{note} Views and offers are estimates; we do not count views yet.</p>
    </section>
  );
}
