"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError, postStaff } from "../staff-api";
import "../../styles/admin.css";
import "../../styles/listing-optimization.css";

interface Settings { enabled: boolean; minPhotos: number; minDescriptionWords: number; maxPriceCutPercent: number; disabledTypes: string[]; updatedAt: string | null; updatedByName: string | null }
interface Stat { type: string; total: number; open: number; implemented: number; dismissed: number; outdated: number; adoptionPercent: number | null; measured: number; enquiriesBefore: number; enquiriesAfter: number; offersBefore: number; offersAfter: number }
interface Change { at: string; actorName: string | null; event: string }
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-AU") : "Never");
const EVENT: Record<string, string> = {
  "staff.listing_optimization.enabled": "Turned listing suggestions on", "staff.listing_optimization.disabled": "Turned listing suggestions off", "staff.listing_optimization.updated": "Changed the suggestion settings"
};

/** Staff screen (listing_optimization.manage): the site switch, the thresholds, and how often sellers follow each kind of suggestion. */
export default function ListingOptimizationSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [stats, setStats] = useState<Stat[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [types, setTypes] = useState<{ type: string; label: string }[]>([]);
  const [draft, setDraft] = useState({ minPhotos: 8, minDescriptionWords: 60, maxPriceCutPercent: 10, disabledTypes: [] as string[] });
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/listing-optimization-settings").catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
    const d = await r.json() as { settings: Settings; stats: Stat[]; changes: Change[]; types: { type: string; label: string }[] };
    setS(d.settings); setStats(d.stats); setChanges(d.changes); setTypes(d.types);
    setDraft({ minPhotos: d.settings.minPhotos, minDescriptionWords: d.settings.minDescriptionWords, maxPriceCutPercent: d.settings.maxPriceCutPercent, disabledTypes: d.settings.disabledTypes });
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(body: Record<string, unknown>, done: string) {
    setBusy(true); setError(""); setNote("");
    const r = await postStaff("/api/staff/listing-optimization-settings", body);
    setBusy(false);
    if (!r.ok) { setError(String(r.data["error"] ?? "Could not save.")); return; }
    setNote(done); await load();
  }
  const label = (t: string) => types.find(x => x.type === t)?.label ?? t;
  const dirty = !!s && (draft.minPhotos !== s.minPhotos || draft.minDescriptionWords !== s.minDescriptionWords || draft.maxPriceCutPercent !== s.maxPriceCutPercent || draft.disabledTypes.join() !== s.disabledTypes.join());
  const toggle = (t: string) => setDraft({ ...draft, disabledTypes: draft.disabledTypes.includes(t) ? draft.disabledTypes.filter(x => x !== t) : [...draft.disabledTypes, t] });
  const change = (a: number, b: number) => (a === 0 && b === 0 ? "–" : `${a} → ${b}`);

  return (
    <main className="admin-page">
      <h1>Listing optimization</h1>
      <p><a href="/staff/dashboard">Back to the admin dashboard</a></p>
      <p className="muted">Elena suggests improvements to sellers&apos; photos, descriptions and prices. Sellers see them on their listing and at /owner/listing-optimization, and mark each one done or dismissed.</p>
      <div aria-live="polite">
        {error && <p role="alert" className="staff-notice">{error}</p>}
        {note && <p role="status">{note}</p>}
      </div>
      {!s && !error && <p className="muted" role="status">Loading…</p>}
      {s && (
        <>
          <section aria-label="Site switch">
            <h2>Site switch</h2>
            <div className={`lo-switch ${s.enabled ? "is-on" : ""}`}>
              <strong>Listing suggestions are {s.enabled ? "ON" : "OFF"} for every seller</strong>
              <button type="button" disabled={busy} onClick={() => void save({ enabled: !s.enabled }, s.enabled ? "Suggestions turned off." : "Suggestions turned on.")}>{s.enabled ? "Turn off" : "Turn on"}</button>
            </div>
            <p className="muted">Last changed {when(s.updatedAt)}{s.updatedByName ? ` by ${s.updatedByName}` : ""}. Off hides every suggestion and answers 404 to the suggestions API.</p>
          </section>

          <section aria-label="Settings">
            <h2>Settings</h2>
            <form className="lo-grid" onSubmit={e => { e.preventDefault(); void save(draft, "Settings saved."); }}>
              <label className="lo-field">Photos expected (3 to 40)
                <input type="number" inputMode="numeric" min={3} max={40} value={draft.minPhotos} onChange={e => setDraft({ ...draft, minPhotos: Number(e.target.value) })} />
                <span className="muted">Fewer visible photos than this triggers &ldquo;Add photos&rdquo;. Default 8.</span>
              </label>
              <label className="lo-field">Description length in words (20 to 300)
                <input type="number" inputMode="numeric" min={20} max={300} value={draft.minDescriptionWords} onChange={e => setDraft({ ...draft, minDescriptionWords: Number(e.target.value) })} />
                <span className="muted">A shorter description triggers &ldquo;Write more&rdquo;. Default 60.</span>
              </label>
              <label className="lo-field">Largest price cut suggested at once (1 to 20%)
                <input type="number" inputMode="numeric" min={1} max={20} value={draft.maxPriceCutPercent} onChange={e => setDraft({ ...draft, maxPriceCutPercent: Number(e.target.value) })} />
                <span className="muted">The price suggestion never goes below the recent middle of sales. Default 10.</span>
              </label>
              <fieldset className="lo-types">
                <legend>Suggestions sellers can see</legend>
                {types.map(t => <label key={t.type}><input type="checkbox" checked={!draft.disabledTypes.includes(t.type)} onChange={() => toggle(t.type)} /> {t.label}</label>)}
              </fieldset>
              <p className="lo-actions-row"><button type="submit" disabled={busy || !dirty}>{busy ? "Saving…" : "Save settings"}</button></p>
            </form>
          </section>

          <section aria-label="Adoption">
            <h2>Do sellers follow the suggestions?</h2>
            {stats.length === 0 ? <p className="muted">No suggestions have been shown yet.</p> : (
              <div className="lo-table-wrap">
                <table>
                  <thead><tr>
                    <th scope="col">Suggestion</th><th scope="col" className="num">Shown</th><th scope="col" className="num">Done</th><th scope="col" className="num">Dismissed</th><th scope="col" className="num">Open</th>
                    <th scope="col" className="num">Followed</th><th scope="col" className="num">Enquiries 14 days before → after</th><th scope="col" className="num">Offers 14 days before → after</th>
                  </tr></thead>
                  <tbody>{stats.map(x => (
                    <tr key={x.type}>
                      <td>{label(x.type)}</td><td className="num">{x.total}</td><td className="num">{x.implemented}</td><td className="num">{x.dismissed}</td><td className="num">{x.open}</td>
                      <td className="num">{x.adoptionPercent === null ? "–" : `${x.adoptionPercent}%`}</td>
                      <td className="num">{x.measured ? change(x.enquiriesBefore, x.enquiriesAfter) : "–"}</td><td className="num">{x.measured ? change(x.offersBefore, x.offersAfter) : "–"}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            <p className="muted">Followed is done out of everything still open, done or dismissed. Enquiries and offers are totals across listings measured 14 days either side of the seller marking a suggestion done; a dash means none is 14 days old yet. This shows what happened, not that the change caused it.</p>
          </section>

          <section aria-label="Change log">
            <h2>Recent changes</h2>
            {changes.length === 0 ? <p className="muted">No changes yet.</p> : (
              <ul className="lo-hist">{changes.map((c, i) => <li key={`${c.at}-${i}`}>{when(c.at)}: {EVENT[c.event] ?? c.event} ({c.actorName ?? "staff"})</li>)}</ul>
            )}
            <p className="muted">The full record is in the <a href="/staff/audit">audit log</a>.</p>
          </section>
        </>
      )}
    </main>
  );
}
