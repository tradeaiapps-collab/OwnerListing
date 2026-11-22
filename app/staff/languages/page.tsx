"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError, postStaff } from "../staff-api";
import "../../styles/admin.css";

interface Lang { code: string; name: string; approved: boolean; enabled: boolean; changedAt: string | null }

/** Staff screen (config.edit): switch a reviewed language on or off for the whole site. */
export default function Languages() {
  const [langs, setLangs] = useState<Lang[] | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/languages").catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
    setLangs(((await r.json()) as { languages: Lang[] }).languages);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggle(l: Lang) {
    setBusy(true); setError(""); setNote("");
    const r = await postStaff("/api/staff/languages", { code: l.code, enabled: !l.enabled });
    setBusy(false);
    if (!r.ok) { setError(String(r.data["error"] ?? "Could not save.")); return; }
    setNote(`${l.name} turned ${l.enabled ? "off" : "on"}.`);
    await load();
  }

  return (
    <main className="admin-page">
      <h1>Site languages</h1>
      <p><a href="/staff/dashboard">Back to the admin dashboard</a></p>
      <p className="muted">A language can be switched on only after its translation has been reviewed and approved. English is always on. Legal documents, disclosures and terms stay in English.</p>
      <div aria-live="polite">
        {error && <p role="alert" className="staff-notice">{error}</p>}
        {note && <p role="status">{note}</p>}
      </div>
      {!langs && !error && <p className="muted" role="status">Loading…</p>}
      {langs && (
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Language and status</th></tr></thead>
            <tbody>
              {langs.map(l => (
                <tr key={l.code}>
                  <td>{l.name} <span className="muted">({l.code})</span><br /><span className="muted">{l.approved ? "Translation approved" : "Translation not approved"} · <strong>{l.enabled ? "On" : "Off"}</strong></span><br /><button type="button" disabled={busy || (!l.enabled && !l.approved)} onClick={() => void toggle(l)}>{l.enabled ? "Turn off" : "Turn on"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
