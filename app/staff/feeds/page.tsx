"use client";
import { useCallback, useEffect, useState } from "react";
import "../../styles/admin.css";
import "../../styles/feeds.css";
import { JSON_HEADERS } from "../../listings/ui";

type Territory = { states: string[]; postcodes: string[]; suburbs: string[] };
type Run = { id: string; trigger: string; status: string; startedAt: string; fetched: number; created: number; updated: number; unchanged: number; skipped: number; rejected: number; events: number; error: string | null };
type Conn = {
  id: string; provider: "reaxml" | "domain"; label: string; agentUserId: string | null; territory: Territory; schedule: string; sourceUrl: string | null;
  hasPushToken: boolean; comparablesLicensed: boolean; licenceTerms: string | null; enabled: boolean; nextRunAt: string | null; lastRun: Run | null;
};
type Outbound = { enabled: boolean; url: string | null; failures: number; enabledAt: string | null };
type Delivery = { id: string; eventType: string; state: string; attempts: number; lastStatus: number | null; lastError: string | null; createdAt: string };
const EVENT_NAMES: Record<string, string> = { "listing.sold": "Sold", "listing.rented": "Rented", "listing.delisted": "Delisted", "listing.reactivated": "Back on market" };
const PROVIDERS = { reaxml: "Agency CRM (REAXML)", domain: "Domain API" } as const;
/** Queensland time, matching the schedule labels (02:00 Queensland). */
const when = (s: string | null) => (s ? new Date(s).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: "Australia/Brisbane" }) : "—");
const area = (t: Territory) => [t.states.join(", "), t.postcodes.join(", "), t.suburbs.join(", ")].filter(Boolean).join(" · ") || "Anywhere";
const runPill = (r: Run | null) => (!r ? <span className="status-pill">Not run yet</span> : r.status === "ok" ? <span className="status-pill good">OK</span> : r.status === "failed" ? <span className="status-pill bad">Failed</span> : <span className="status-pill warn">Running</span>);

/** Staff screen for property data feeds: add a connection, run it, pause it, issue a CRM push token, read the run log. feeds.manage only. */
export default function StaffFeeds() {
  const [conns, setConns] = useState<Conn[] | null>(null);
  const [setup, setSetup] = useState({ domainConfigured: false, cronConfigured: false });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [token, setToken] = useState<{ id: string; token: string } | null>(null);
  const [runs, setRuns] = useState<{ id: string; label: string; rows: Run[] } | null>(null);
  const [busy, setBusy] = useState("");
  const [sync, setSync] = useState<{ id: string; label: string; outbound: Outbound; deliveries: Delivery[]; url: string } | null>(null);
  const [secret, setSecret] = useState("");
  const [form, setForm] = useState({ provider: "reaxml", label: "", agentUserId: "", sourceUrl: "", states: "QLD", postcodes: "", suburbs: "", schedule: "daily", comparablesLicensed: false, licenceTerms: "" });

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/feeds").catch(() => null);
    if (!r) return setError("Could not load the feeds.");
    if (r.status === 401) return setError("Sign in as staff to manage feeds.");
    if (r.status === 403) return setError("Your role cannot manage property feeds.");
    if (!r.ok) return setError("Could not load the feeds.");
    const d = await r.json();
    setConns(d.connections); setSetup({ domainConfigured: d.domainConfigured, cronConfigured: d.cronConfigured }); setError("");
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(c: Conn, action: string) {
    setBusy(`${c.id}:${action}`); setNotice(""); setError("");
    try {
      const r = await fetch(`/api/staff/feeds/${c.id}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? "That did not work."); return; }
      if (action === "rotate_token") setToken({ id: c.id, token: d.pushToken });
      if (action === "run") setNotice(d.run.status === "ok" ? `${c.label}: ${d.run.created} new, ${d.run.updated} updated, ${d.run.unchanged} unchanged, ${d.run.events} history events.` : `${c.label}: ${d.run.error ?? "the run failed."}`);
      await load();
      if (runs?.id === c.id) await showRuns(c);
    } finally { setBusy(""); }
  }

  async function showRuns(c: Conn) {
    const r = await fetch(`/api/staff/feeds/${c.id}`).catch(() => null);
    if (!r?.ok) return setError("Could not load the run log.");
    const d = await r.json();
    setRuns({ id: c.id, label: c.label, rows: d.runs });
  }

  async function showSync(c: Conn) {
    setError(""); setSecret("");
    const r = await fetch(`/api/staff/feeds/${c.id}`).catch(() => null);
    if (!r || !r.ok) { setError("Could not load status sync."); return; }
    const d = await r.json();
    setSync({ id: c.id, label: c.label, outbound: d.outbound, deliveries: d.deliveries, url: d.outbound?.url ?? "" });
  }
  async function syncAction(action: "enable_outbound" | "disable_outbound") {
    if (!sync) return;
    setBusy("sync"); setError(""); setNotice("");
    try {
      const r = await fetch(`/api/staff/feeds/${sync.id}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action, url: sync.url }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? "That did not work."); return; }
      if (d.secret) setSecret(d.secret);
      setNotice(action === "enable_outbound" ? "Status sync is on. Only changes from now on are sent." : "Status sync is off.");
      await showSync({ id: sync.id, label: sync.label } as Conn);
    } finally { setBusy(""); }
  }

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy("create"); setError(""); setNotice("");
    try {
      const body = {
        provider: form.provider, label: form.label, schedule: form.schedule,
        territory: { states: form.states, postcodes: form.postcodes, suburbs: form.suburbs },
        ...(form.provider === "reaxml" ? { agentUserId: form.agentUserId, sourceUrl: form.sourceUrl } : {}),
        comparablesLicensed: form.comparablesLicensed, licenceTerms: form.licenceTerms
      };
      const r = await fetch("/api/staff/feeds", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? "Could not add the connection."); return; }
      if (d.pushToken) setToken({ id: d.id, token: d.pushToken });
      setNotice(`Added "${form.label}".`);
      setForm(f => ({ ...f, label: "", agentUserId: "", sourceUrl: "", postcodes: "", suburbs: "", comparablesLicensed: false, licenceTerms: "" }));
      await load();
    } finally { setBusy(""); }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <main className="feeds">
      <h1>Property data feeds</h1>
      <p className="muted">Agency CRM feeds (REAXML from VaultRE, Rex, Agentbox, MRI and others) and the Domain API. Imports fill the property history used for market data. CRM listings are staged in the agent's workspace; nothing publishes on its own.</p>
      <ul className="feeds-setup" aria-label="Setup">
        <li><span className={`status-pill ${setup.cronConfigured ? "good" : "warn"}`}>{setup.cronConfigured ? "On" : "Off"}</span> Scheduled runs <small className="muted">FEED_CRON_SECRET</small></li>
        <li><span className={`status-pill ${setup.domainConfigured ? "good" : "warn"}`}>{setup.domainConfigured ? "On" : "Off"}</span> Domain API key <small className="muted">DOMAIN_CLIENT_ID, DOMAIN_CLIENT_SECRET</small></li>
      </ul>
      {error && <p role="alert" className="feeds-msg bad">{error}</p>}
      {notice && <p role="status" className="feeds-msg">{notice}</p>}
      {token && (
        <div className="feeds-token" role="status">
          <strong>CRM push details: copy them now, the token is not shown again.</strong>
          <dl>
            <dt>Address</dt><dd><code>{origin}/api/feeds/reaxml/{token.id}</code></dd>
            <dt>Header</dt><dd><code>Authorization: Bearer {token.token}</code></dd>
          </dl>
          <button type="button" className="secondary" onClick={() => setToken(null)}>Done</button>
        </div>
      )}

      <h2>Connections</h2>
      {conns === null && !error && <p className="muted" role="status">Loading…</p>}
      {conns?.length === 0 && <p className="empty">No feeds yet. Add an agency's CRM feed or a Domain connection below.</p>}
      {conns && conns.length > 0 && (
        <div className="table-wrap"><table className="feeds-table">
          <thead><tr><th>Name</th><th>Source</th><th>Area</th><th>Schedule</th><th>Last run</th><th>Actions</th></tr></thead>
          <tbody>{conns.map(c => (
            <tr key={c.id}>
              <td data-label="Name"><span><strong>{c.label}</strong>{!c.enabled && <> <span className="status-pill">Paused</span></>}</span>{c.comparablesLicensed && <div><small className="muted">Sold prices used in comparables</small></div>}</td>
              <td data-label="Source"><span>{PROVIDERS[c.provider]}</span>{c.provider === "reaxml" && <div><small className="muted">{c.sourceUrl ? "Pull and push" : "Push only"}</small></div>}</td>
              <td data-label="Area"><span>{area(c.territory)}</span></td>
              <td data-label="Schedule"><span>{c.schedule === "manual" ? "Manual" : c.schedule === "weekly" ? "Weekly" : "Daily"}</span>{c.enabled && c.nextRunAt && <div><small className="muted">Next {when(c.nextRunAt)}</small></div>}</td>
              <td data-label="Last run">{runPill(c.lastRun)}{c.lastRun && <div><small className="muted">{when(c.lastRun.startedAt)}{c.lastRun.status === "ok" ? ` · ${c.lastRun.created + c.lastRun.updated} changed` : ""}</small></div>}</td>
              <td data-label="Actions"><div className="row-actions">
                <button type="button" disabled={!c.enabled || !!busy} onClick={() => act(c, "run")}>{busy === `${c.id}:run` ? "Running…" : "Run now"}</button>
                <button type="button" className="secondary" disabled={!!busy} onClick={() => act(c, c.enabled ? "pause" : "resume")}>{c.enabled ? "Pause" : "Resume"}</button>
                {c.provider === "reaxml" && <button type="button" className="secondary" disabled={!!busy} onClick={() => act(c, "rotate_token")}>New push token</button>}
                <button type="button" className="secondary" onClick={() => showRuns(c)}>Run log</button>
                {c.provider === "reaxml" && <button type="button" className="secondary" onClick={() => showSync(c)}>Status sync</button>}
              </div></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}

      {sync && (
        <section aria-labelledby="sync-h" className="feeds-sync">
          <h2 id="sync-h">Status sync back to the CRM: {sync.label}</h2>
          <p className="muted">When a listing is sold, rented or delisted (or comes back on the market) we send a signed JSON message to the CRM's webhook address. Retries run over about 2.5 hours; after 10 failed messages in a row sync switches itself off.</p>
          <p><span className={`status-pill ${sync.outbound.enabled ? "good" : ""}`}>{sync.outbound.enabled ? "On" : "Off"}</span>{sync.outbound.failures > 0 && <> <small className="muted">{sync.outbound.failures} recent failure{sync.outbound.failures === 1 ? "" : "s"}</small></>}</p>
          {secret && (
            <div className="feeds-token" role="status">
              <strong>Signing secret: copy it now, it is not shown again.</strong>
              <dl><dt>Secret</dt><dd><code>{secret}</code></dd><dt>Header</dt><dd><code>ol-signature: t=&lt;unix time&gt;,v1=&lt;HMAC-SHA256 of "&lt;t&gt;.&lt;body&gt;"&gt;</code></dd></dl>
              <button type="button" className="secondary" onClick={() => setSecret("")}>Done</button>
            </div>
          )}
          <div className="stack feeds-form">
            <label>CRM webhook address (https) <input type="url" value={sync.url} onChange={e => setSync({ ...sync, url: e.target.value })} placeholder="https://crm.example.com/hooks/listings" maxLength={500} /></label>
            <div className="row-actions">
              <button type="button" disabled={busy === "sync" || !sync.url} onClick={() => syncAction("enable_outbound")}>{sync.outbound.enabled ? "Save and new secret" : "Turn on"}</button>
              {sync.outbound.enabled && <button type="button" className="secondary" disabled={busy === "sync"} onClick={() => syncAction("disable_outbound")}>Turn off</button>}
              <button type="button" className="secondary" onClick={() => { setSync(null); setSecret(""); }}>Close</button>
            </div>
          </div>
          <h3>Recent messages</h3>
          {sync.deliveries.length === 0 ? <p className="empty">Nothing sent yet.</p> : (
            <div className="table-wrap"><table className="feeds-table">
              <thead><tr><th>Queued</th><th>Change</th><th>Result</th><th className="num">Tries</th></tr></thead>
              <tbody>{sync.deliveries.map(x => (
                <tr key={x.id}>
                  <td data-label="Queued"><span>{when(x.createdAt)}</span></td>
                  <td data-label="Change"><span>{EVENT_NAMES[x.eventType] ?? x.eventType}</span></td>
                  <td data-label="Result"><span className={`status-pill ${x.state === "delivered" ? "good" : x.state === "failed" ? "bad" : "warn"}`}>{x.state === "delivered" ? "Delivered" : x.state === "failed" ? "Failed" : "Waiting"}</span>{x.lastError && <div><small>{x.lastError}</small></div>}</td>
                  <td data-label="Tries" className="num">{x.attempts}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      )}

      {runs && (
        <section aria-labelledby="runs-h">
          <h2 id="runs-h">Run log: {runs.label}</h2>
          {runs.rows.length === 0 ? <p className="empty">No runs yet.</p> : (
            <div className="table-wrap"><table className="feeds-table">
              <thead><tr><th>Started</th><th>Result</th><th className="num">New</th><th className="num">Updated</th><th className="num">Same</th><th className="num" title="Outside the connection's area">Skipped</th><th className="num">Rejected</th><th className="num">Events</th></tr></thead>
              <tbody>{runs.rows.map(r => (
                <tr key={r.id}>
                  <td data-label="Started"><span>{when(r.startedAt)}</span><div><small className="muted">{r.trigger === "schedule" ? "Schedule" : r.trigger === "push" ? "CRM push" : "Staff"}</small></div></td>
                  <td data-label="Result">{runPill(r)}{r.error && <div><small>{r.error}</small></div>}</td>
                  <td data-label="New" className="num">{r.created}</td><td data-label="Updated" className="num">{r.updated}</td><td data-label="Same" className="num">{r.unchanged}</td>
                  <td data-label="Skipped" className="num">{r.skipped}</td><td data-label="Rejected" className="num">{r.rejected}</td><td data-label="Events" className="num">{r.events}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      )}

      <h2>Add a connection</h2>
      <form className="stack feeds-form" onSubmit={onCreate}>
        <div className="feeds-grid">
          <label>Source <select value={form.provider} onChange={set("provider")}><option value="reaxml">Agency CRM (REAXML)</option><option value="domain">Domain API</option></select></label>
          <label>Name <input value={form.label} onChange={set("label")} placeholder={form.provider === "reaxml" ? "e.g. Ray White Paddington (VaultRE)" : "e.g. Domain SEQ market data"} minLength={2} maxLength={80} required /></label>
          {form.provider === "reaxml" && <>
            <label>Agent's user id <input value={form.agentUserId} onChange={set("agentUserId")} placeholder="The agent whose CRM this is" required /></label>
            <label>Pull address (optional) <input type="url" value={form.sourceUrl} onChange={set("sourceUrl")} placeholder="https://… if the CRM publishes a feed URL" /></label>
          </>}
          <label>States <input value={form.states} onChange={set("states")} placeholder="QLD, NSW" /></label>
          <label>Postcodes <input value={form.postcodes} onChange={set("postcodes")} placeholder="4064, 4000" inputMode="numeric" /></label>
          <label>Suburbs <input value={form.suburbs} onChange={set("suburbs")} placeholder="Paddington, Red Hill" /></label>
          <label>Schedule <select value={form.schedule} onChange={set("schedule")}><option value="daily">Daily (02:00 Queensland)</option><option value="weekly">Weekly (Sunday 02:00)</option><option value="manual">Manual only</option></select></label>
        </div>
        <label className="feeds-check"><input type="checkbox" checked={form.comparablesLicensed} onChange={set("comparablesLicensed")} /> Our licence allows using these sold prices in valuations and comparables</label>
        {form.comparablesLicensed && <label>Licence terms (what allows it, and where it is recorded) <textarea value={form.licenceTerms} onChange={set("licenceTerms")} minLength={10} maxLength={1000} required /></label>}
        <div><button type="submit" disabled={busy === "create"}>{busy === "create" ? "Adding…" : "Add connection"}</button></div>
      </form>
    </main>
  );
}
