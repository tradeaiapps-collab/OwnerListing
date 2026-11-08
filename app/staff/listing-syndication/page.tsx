"use client";
import { useCallback, useEffect, useState } from "react";
import "../../styles/staff.css";
import "../../styles/syndication.css";
import { loadError, postStaff } from "../staff-api";

type Portal = "airbnb" | "vrbo" | "booking_com";
interface PortalRow { portal: Portal; enabled: boolean; mode: "api" | "manual" | "channex"; baseUrl: string | null; hasKey: boolean; hasWebhookSecret: boolean; allowedTransactionTypes: string[]; maxPerMinute: number; ready: boolean }
interface Failure { listingId: string; title: string; portal: Portal; error: string | null; attempts: number; updatedAt: string }
interface View { portals: PortalRow[]; counts: Record<string, Record<string, number>>; failures: Failure[] }

const LABELS: Record<Portal, string> = { airbnb: "Airbnb", vrbo: "VRBO", booking_com: "Booking.com" };
const STATES: [string, string][] = [["live", "Live"], ["manual", "Manual link"], ["pending", "Waiting"], ["failed", "Failed"], ["removed", "Removed"]];
const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });

function PortalCard({ p, counts, onSaved, onSecret, onError }: { p: PortalRow; counts: Record<string, number>; onSaved: (v: PortalRow) => void; onSecret: (portal: Portal, s: string) => void; onError: (m: string) => void }) {
  const [mode, setMode] = useState(p.mode);
  const [baseUrl, setBaseUrl] = useState(p.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [types, setTypes] = useState(p.allowedTransactionTypes);
  const [rate, setRate] = useState(String(p.maxPerMinute));
  const [busy, setBusy] = useState(false);
  const id = `syn-${p.portal}`;

  async function put(body: Record<string, unknown>, done?: string) {
    setBusy(true); onError("");
    try {
      const r = await fetch("/api/staff/syndication", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ portal: p.portal, ...body }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { onSaved(d.portal); setApiKey(""); if (d.newWebhookSecret) onSecret(p.portal, d.newWebhookSecret); if (done) onError(""); }
      else onError(d.error ?? "Could not save.");
    } catch { onError("Could not save."); } finally { setBusy(false); }
  }
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void put({ mode, baseUrl: baseUrl.trim() === "" ? null : baseUrl.trim(), allowedTransactionTypes: types, maxPerMinute: Number(rate), ...(apiKey ? { apiKey } : {}) });
  };
  const toggleType = (t: string) => setTypes(types.includes(t) ? types.filter(x => x !== t) : [...types, t]);

  return (
    <section className="syn-panel" aria-labelledby={`${id}-h`}>
      <div className="syn-head">
        <h2 id={`${id}-h`}>{LABELS[p.portal]}</h2>
        <span className={`syn-pill ${p.enabled ? "is-live" : ""}`}>{p.enabled ? "On" : "Off"}</span>
      </div>
      <p className="syn-note">{STATES.map(([k, l]) => `${l}: ${counts[k] ?? 0}`).join(" · ")}</p>
      <form className="syn-form" onSubmit={save}>
        <div className="syn-fields">
          <label>How listings reach the portal
            <select value={mode} onChange={e => setMode(e.target.value as "api" | "manual" | "channex")}>
              <option value="manual">Manual link (owner lists on the portal and pastes the link)</option>
              <option value="channex">Channex (owner connects own account)</option>
              <option value="api">Automatic (we push through the portal's partner API)</option>
            </select>
          </label>
          <label>Most requests per minute
            <input inputMode="numeric" value={rate} onChange={e => setRate(e.target.value)} />
          </label>
          {mode === "api" && (
            <>
              <label className="is-wide">Partner API address
                <input type="url" autoComplete="off" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://partner-api.example.com/v1" />
              </label>
              <label className="is-wide">API key <span className="syn-note">[{p.hasKey ? "set" : "not set"}]</span>
                <input type="password" autoComplete="off" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={p.hasKey ? "Leave empty to keep" : ""} />
              </label>
            </>
          )}
        </div>
        <fieldset className="syn-form">
          <legend>Listing types allowed on this portal</legend>
          {(["rent", "sale"] as const).map(t => (
            <label key={t} className="syn-check"><input type="checkbox" checked={types.includes(t)} onChange={() => toggleType(t)} />{t === "rent" ? "For rent (including short stays)" : "For sale"}</label>
          ))}
        </fieldset>
        <div className="syn-actions">
          <button type="submit" disabled={busy || types.length === 0}>{busy ? "Working…" : "Save"}</button>
          {mode === "api" && <button type="button" disabled={busy} onClick={() => void put({ generateWebhookSecret: true })}>{p.hasWebhookSecret ? "Make a new webhook secret" : "Make webhook secret"}</button>}
          <button type="button" disabled={busy || (!p.enabled && !(mode === "manual" || mode === "channex" || (p.hasKey && p.hasWebhookSecret && !!p.baseUrl)))} onClick={() => void put({ enabled: !p.enabled })}>{p.enabled ? "Switch off" : "Switch on"}</button>
        </div>
      </form>
      {mode === "channex" && <p className="syn-note">Uses the site's Channex account (CHANNEX_API_KEY). Booking webhook in Channex: <code>/api/webhooks/channex</code>; bookings are also pulled on every worker run.</p>}
      {mode === "api" && <p className="syn-note">Webhook address for this portal: <code>/api/webhooks/syndication/{p.portal}</code> [{p.hasWebhookSecret ? "secret set" : "no secret yet"}]</p>}
    </section>
  );
}

export default function StaffSyndication() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [secret, setSecret] = useState<{ portal: Portal; value: string } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/syndication").catch(() => null);
    if (!r) { setError("Could not load."); return; }
    if (!r.ok) { setError(loadError(r.status)); return; }
    setView(await r.json());
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function retry(f: Failure) {
    setError(""); setNote("");
    const r = await postStaff("/api/staff/syndication/retry", { listingId: f.listingId, portal: f.portal });
    if (r.ok) { setNote(`Retried ${f.title}: ${String(r.data["outcome"])}.`); await load(); } else setError(String(r.data["error"] ?? "Could not retry."));
  }

  return (
    <main className="syn-page">
      <header>
        <h1>Listing portals</h1>
        <p className="syn-note">Share published rental listings on other sites and take their bookings back. Owners choose per listing; nothing is sent until you switch a portal on. Keys are stored encrypted and never shown again.</p>
      </header>
      <div aria-live="polite">
        {error && <p role="alert" className="syn-panel">{error}</p>}
        {note && <p role="status" className="syn-panel">{note}</p>}
      </div>
      {secret && (
        <section className="syn-panel" aria-label="New webhook secret">
          <h2>Webhook secret for {LABELS[secret.portal]}</h2>
          <p className="syn-note">Copy it into the portal's webhook settings now. It is not shown again.</p>
          <p className="syn-secret">{secret.value}</p>
          <div className="syn-actions"><button type="button" onClick={() => setSecret(null)}>I have copied it</button></div>
        </section>
      )}
      {!view && !error && <p className="syn-note" role="status">Loading…</p>}
      <div className="syn-grid">
        {view?.portals.map(p => (
          <PortalCard key={`${p.portal}-${p.enabled}-${p.hasKey}-${p.hasWebhookSecret}`} p={p} counts={view.counts[p.portal] ?? {}} onError={setError}
            onSecret={(portal, value) => setSecret({ portal, value })}
            onSaved={v => { setNote("Saved."); setView({ ...view, portals: view.portals.map(x => (x.portal === v.portal ? v : x)) }); }} />
        ))}
      </div>
      {view && (
        <section className="syn-panel" aria-labelledby="syn-fail-h">
          <h2 id="syn-fail-h">Failed pushes</h2>
          {view.failures.length === 0 ? <p className="syn-note">Nothing has failed.</p> : (
            <div className="syn-table-wrap">
              <table className="syn-table">
                <thead><tr><th>Listing</th><th>Portal</th><th>Error</th><th className="num">Tries</th><th>Last try</th><th><span className="sr-only">Action</span></th></tr></thead>
                <tbody>
                  {view.failures.map(f => (
                    <tr key={`${f.listingId}-${f.portal}`}>
                      <td>{f.title}</td><td>{LABELS[f.portal]}</td><td>{f.error ?? "Unknown"}</td><td className="num">{f.attempts}</td><td>{when(f.updatedAt)}</td>
                      <td><button type="button" onClick={() => void retry(f)}>Retry</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
