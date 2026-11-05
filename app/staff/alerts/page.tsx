"use client";
import { useCallback, useEffect, useState } from "react";
import { exampleText, type AlertDef, type AlertSettings, type AlertType } from "../../../src/domain/alert-config";
import { loadError } from "../staff-api";

interface View { settings: AlertSettings; defaults: AlertSettings; defs: AlertDef[]; canEdit: boolean }
type Draft = Record<AlertType, { threshold: string; enabled: boolean }>;
const toDraft = (s: AlertSettings): Draft =>
  Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { threshold: String(v.threshold), enabled: v.enabled }])) as Draft;

/** Staff page for the thresholds behind Elena's admin alerts. Everyone who sees the insights can read it; config.edit can save. */
export default function AlertThresholds() {
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/alerts").catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
    const v: View = await r.json();
    setView(v); setDraft(toDraft(v.settings));
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!view || !draft) return;
    setBusy(true); setError(""); setNote("");
    const settings = Object.fromEntries(view.defs.map(d => [d.type, { threshold: Number(draft[d.type].threshold), enabled: draft[d.type].enabled }]));
    const r = await fetch("/api/staff/alerts", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings }) }).catch(() => null);
    setBusy(false);
    const data = r ? await r.json().catch(() => ({})) : {};
    if (r?.ok) { setView(data as View); setDraft(toDraft((data as View).settings)); setNote("Saved. Elena's insights use these from now on."); }
    else setError(r ? String((data as { error?: string }).error ?? "Could not save.") : "Network error.");
  }
  const dirty = !!view && !!draft && JSON.stringify(draft) !== JSON.stringify(toDraft(view.settings));
  const set = (t: AlertType, patch: Partial<Draft[AlertType]>) => draft && setDraft({ ...draft, [t]: { ...draft[t], ...patch } });

  return (
    <main className="admin-page">
      <h1>Alert thresholds</h1>
      <p><a href="/staff/elena-insights">Back to Elena's insights</a></p>
      <p className="muted">These settings apply to everyone and to every area and agent. A switched-off alert never appears. Small samples are still never flagged.</p>
      <div aria-live="polite">
        {error && <p role="alert">{error}</p>}
        {note && <p role="status">{note}</p>}
      </div>
      {!view && !error && <p className="muted" role="status">Loading…</p>}
      {view && draft && (
        <form onSubmit={save}>
          {!view.canEdit && <p className="muted">Your role can read these but not change them.</p>}
          <div className="table-wrap"><table>
            <thead><tr>
              <th scope="col">Alert</th><th scope="col">What it watches</th><th scope="col" className="num">Threshold</th><th scope="col">Default</th><th scope="col">On</th>
            </tr></thead>
            <tbody>
              {view.defs.map(d => {
                const n = Number(draft[d.type].threshold);
                const bad = !Number.isFinite(n) || n < d.min || n > d.max;
                return (
                  <tr key={d.type}>
                    <td><strong>{d.label}</strong></td>
                    <td>{d.description}<br /><span className="muted">{bad ? `Enter ${d.min} to ${d.max}.` : exampleText(d, n)}</span></td>
                    <td className="num">
                      <input type="number" aria-label={`${d.label} threshold (${d.unit})`} min={d.min} max={d.max} step={d.step} value={draft[d.type].threshold}
                        disabled={!view.canEdit || busy} aria-invalid={bad} onChange={e => set(d.type, { threshold: e.target.value })} style={{ width: "5.5rem" }} />
                      <br /><span className="muted">{d.unit}</span>
                    </td>
                    <td>{d.defaultThreshold}</td>
                    <td><input type="checkbox" aria-label={`${d.label} on`} checked={draft[d.type].enabled} disabled={!view.canEdit || busy} onChange={e => set(d.type, { enabled: e.target.checked })} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
          {view.canEdit && (
            <p>
              <button type="submit" disabled={busy || !dirty}>{busy ? "Saving…" : "Save thresholds"}</button>{" "}
              <button type="button" className="secondary" disabled={busy} onClick={() => setDraft(toDraft(view.defaults))}>Reset to defaults</button>
            </p>
          )}
        </form>
      )}
    </main>
  );
}
