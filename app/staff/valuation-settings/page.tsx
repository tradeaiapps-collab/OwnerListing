"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError, postStaff } from "../staff-api";
import "../../styles/admin.css";
import "../../styles/valuation.css";

interface Settings { enabled: boolean; minComps: number; highConfidenceComps: number; showRange: boolean; updatedAt: string | null; updatedByName: string | null }
interface Override { listingId: string; title: string | null; enabled: boolean; reason: string; setBy: string | null; setAt: string }
interface Change { at: string; actorName: string | null; event: string; payload: Record<string, unknown> }
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-AU") : "Never");
const EVENT: Record<string, string> = {
  "staff.valuation.enabled": "Turned valuations on for the site", "staff.valuation.disabled": "Turned valuations off for the site", "staff.valuation.updated": "Changed the valuation settings",
  "staff.valuation.listing_enabled": "Showed the valuation on a listing", "staff.valuation.listing_disabled": "Hid the valuation on a listing", "staff.valuation.override_cleared": "Cleared a listing's valuation setting"
};

/** Master admin screen (valuation.manage): the site-wide switch, the minimum number of sales, and the listings that differ from the site setting. */
export default function ValuationSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [draft, setDraft] = useState({ minComps: 8, highConfidenceComps: 12, showRange: true });
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/valuation-settings").catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
    const d = await r.json() as { settings: Settings; overrides: Override[]; changes: Change[] };
    setS(d.settings); setOverrides(d.overrides); setChanges(d.changes);
    setDraft({ minComps: d.settings.minComps, highConfidenceComps: d.settings.highConfidenceComps, showRange: d.settings.showRange });
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(body: Record<string, unknown>, done: string) {
    setBusy(true); setError(""); setNote("");
    const r = await postStaff("/api/staff/valuation-settings", body);
    setBusy(false);
    if (!r.ok) { setError(String(r.data["error"] ?? "Could not save.")); return; }
    setNote(done); await load();
  }
  const dirty = !!s && (draft.minComps !== s.minComps || draft.highConfidenceComps !== s.highConfidenceComps || draft.showRange !== s.showRange);

  return (
    <main className="admin-page">
      <h1>Property valuations</h1>
      <p><a href="/staff/dashboard">Back to the admin dashboard</a></p>
      <p className="muted">Buyers see a valuation card on sale listings: whether the asking price is fairly priced, underpriced or overpriced against recent comparable sales. It is a guide only, not a licensed valuation. The site switch below is the master switch.</p>
      <div aria-live="polite">
        {error && <p role="alert" className="staff-notice">{error}</p>}
        {note && <p role="status">{note}</p>}
      </div>
      {!s && !error && <p className="muted" role="status">Loading…</p>}
      {s && (
        <>
          <section aria-label="Site switch">
            <h2>Site switch</h2>
            <div className={`vl-switch ${s.enabled ? "is-on" : ""}`}>
              <strong>Property valuations are {s.enabled ? "ON" : "OFF"} across all listings</strong>
              <button type="button" disabled={busy} onClick={() => void save({ enabled: !s.enabled }, s.enabled ? "Valuations turned off for every listing." : "Valuations turned on.")}>
                {s.enabled ? "Turn off" : "Turn on"}
              </button>
            </div>
            <p className="muted">Last changed {when(s.updatedAt)}{s.updatedByName ? ` by ${s.updatedByName}` : ""}. Off hides every valuation card and answers 404 to the valuation API.</p>
          </section>

          <section aria-label="Settings">
            <h2>Settings</h2>
            <form className="vl-grid" onSubmit={e => { e.preventDefault(); void save(draft, "Settings saved."); }}>
              <label className="vl-field">Minimum sales needed (3 to 50)
                <input type="number" inputMode="numeric" min={3} max={50} value={draft.minComps} onChange={e => setDraft({ ...draft, minComps: Number(e.target.value) })} />
                <span className="muted">Fewer comparable sales than this shows &ldquo;Valuation unavailable&rdquo;. Default 8.</span>
              </label>
              <label className="vl-field">Sales needed for high confidence (at least the minimum)
                <input type="number" inputMode="numeric" min={3} max={100} value={draft.highConfidenceComps} onChange={e => setDraft({ ...draft, highConfidenceComps: Number(e.target.value) })} />
                <span className="muted">At or above this many sales, with prices close together, confidence reads High. Otherwise Medium. Default 12.</span>
              </label>
              <label className="vl-field">
                <span><input type="checkbox" checked={draft.showRange} onChange={e => setDraft({ ...draft, showRange: e.target.checked })} /> Show the market range on the valuation card</span>
                <span className="muted">The range is the middle of recent sales, plus and minus 10%.</span>
              </label>
              <p className="vl-actions"><button type="submit" disabled={busy || !dirty}>{busy ? "Saving…" : "Save settings"}</button></p>
            </form>
          </section>

          <section aria-label="Listings that differ">
            <h2>Listings with their own setting</h2>
            {overrides.length === 0 ? <p className="muted">No listing differs from the site setting. To change one, open it from <a href="/staff/listings">Listing moderation</a>.</p> : (
              <div className="vl-table-wrap">
                <table>
                  <thead><tr><th scope="col">Listing</th><th scope="col">Valuation</th><th scope="col">Reason</th><th scope="col">Set</th></tr></thead>
                  <tbody>{overrides.map(o => (
                    <tr key={o.listingId}>
                      <td><a href={`/staff/listings/${o.listingId}`}>{o.title ?? o.listingId}</a></td>
                      <td>{o.enabled ? "Shown" : "Hidden"}</td><td style={{ whiteSpace: "normal" }}>{o.reason}</td><td>{when(o.setAt)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </section>

          <section aria-label="Change log">
            <h2>Recent changes</h2>
            {changes.length === 0 ? <p className="muted">No changes yet.</p> : (
              <ul className="vl-hist">{changes.map((c, i) => <li key={`${c.at}-${i}`}>{when(c.at)}: {EVENT[c.event] ?? c.event} ({c.actorName ?? "staff"})</li>)}</ul>
            )}
            <p className="muted">The full record is in the <a href="/staff/audit">audit log</a>.</p>
          </section>
        </>
      )}
    </main>
  );
}
