"use client";
import { useCallback, useEffect, useState } from "react";
import { aud, LEAD_STATUSES, type LeadInterest, type LeadStatus } from "../../../src/domain/lead-ads";
import "../../styles/admin.css";
import "../../styles/feeds.css";
import "../../styles/leads.css";
import { JSON_HEADERS } from "../../listings/ui";

type Row = {
  id: string; sourceLabel: string; provider: "meta" | "google"; name: string | null; email: string | null; phone: string | null; interest: LeadInterest | null;
  suburb: string | null; postcode: string | null; campaign: string | null; isTest: boolean; status: LeadStatus; lostReason: string | null;
  assignedAgentId: string | null; assignedAgentName: string | null; followupStatus: string; stage: string; receivedAt: string;
};
type Figures = { leads: number; contacted: number; enquired: number; offered: number; spendCents: number; costPerLeadCents: number | null; costPerEnquiryCents: number | null; contactRate: number | null; enquiryRate: number | null; offerRate: number | null };
type Source = { id: string; provider: "meta" | "google"; label: string; accountRef: string; defaultAgentId: string | null; defaultAgentName: string | null; followupMode: "off" | "contact" | "matches"; enabled: boolean; figures: Figures };
type Agent = { id: string; name: string };
type Data = { leads: Row[]; total: number; pageSize: number; offset: number; days: number; sources: Source[]; agents: Agent[]; metaConfigured: boolean };

const PROVIDER = { meta: "Facebook / Instagram", google: "Google" } as const;
const INTEREST = { buying: "Buying", selling: "Selling", renting: "Renting" } as const;
const STATUS = { new: "New", contacted: "Contacted", qualified: "Qualified", lost: "Lost" } as const;
const STAGE: Record<string, { label: string; tone: string }> = {
  new: { label: "New", tone: "warn" }, contacted: { label: "Contacted", tone: "" }, qualified: { label: "Qualified", tone: "" },
  lost: { label: "Lost", tone: "bad" }, enquiry: { label: "Enquired", tone: "good" }, offer: { label: "Offer made", tone: "good" }
};
const FOLLOWUP = { off: "Off", contact: "Agent contact details", matches: "Matching properties" } as const;
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const when = (s: string) => new Date(s).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: "Australia/Brisbane" });
const today = () => new Date().toISOString().slice(0, 10);

/** Staff inbox for leads from Facebook, Instagram and Google ads, and the ad accounts, spend and figures behind them. leads.manage only. */
export default function StaffLeads() {
  const [tab, setTab] = useState<"inbox" | "sources">("inbox");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [filter, setFilter] = useState({ status: "", source: "", days: "30", offset: 0 });
  const [secret, setSecret] = useState<{ id: string; key: string } | null>(null);
  const [lost, setLost] = useState<{ id: string; reason: string } | null>(null);
  const [form, setForm] = useState({ provider: "meta", label: "", accountRef: "", defaultAgentId: "", followupMode: "off" });
  const [spend, setSpend] = useState({ sourceId: "", day: today(), amount: "" });
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const load = useCallback(async () => {
    const q = new URLSearchParams({ days: filter.days, offset: String(filter.offset) });
    if (filter.status) q.set("status", filter.status);
    if (filter.source) q.set("source", filter.source);
    const r = await fetch(`/api/staff/leads?${q}`).catch(() => null);
    if (!r) return setError("Could not load the leads.");
    if (r.status === 401) return setError("Sign in as staff to see leads.");
    if (r.status === 403) return setError("Your role cannot see ad leads.");
    if (!r.ok) return setError("Could not load the leads.");
    setData(await r.json()); setError("");
  }, [filter]);
  useEffect(() => { void load(); }, [load]);

  async function post(url: string, body: unknown, key: string): Promise<Record<string, unknown> | null> {
    setBusy(key); setNotice(""); setError("");
    try {
      const r = await fetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? "That did not work."); return null; }
      return d;
    } finally { setBusy(""); }
  }
  async function setStatus(l: Row, status: LeadStatus, reason?: string) {
    if (status === "lost" && !reason) return setLost({ id: l.id, reason: "" });
    if (await post(`/api/staff/leads/${l.id}`, { action: "status", status, reason }, l.id)) { setLost(null); await load(); }
  }
  async function assign(l: Row, agentId: string) {
    if (await post(`/api/staff/leads/${l.id}`, { action: "assign", agentId: agentId || null }, l.id)) await load();
  }
  async function src(s: Source, body: Record<string, unknown>) {
    const d = await post(`/api/staff/lead-sources/${s.id}`, body, `${s.id}:${body["action"]}`);
    if (!d) return;
    if (d["webhookKey"]) setSecret({ id: s.id, key: String(d["webhookKey"]) });
    await load();
  }
  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = await post("/api/staff/lead-sources", { ...form, defaultAgentId: form.defaultAgentId || null }, "create");
    if (!d) return;
    if (d["webhookKey"]) setSecret({ id: String(d["id"]), key: String(d["webhookKey"]) });
    setNotice(`Connected "${form.label}".`);
    setForm(f => ({ ...f, label: "", accountRef: "" }));
    await load();
  }
  async function onSpend(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const s = data?.sources.find(x => x.id === spend.sourceId);
    if (!s) return setError("Pick a source.");
    if (await post(`/api/staff/lead-sources/${s.id}`, { action: "spend", rows: [{ day: spend.day, spend: Number(spend.amount) }] }, "spend")) {
      setNotice(`Recorded ${aud(Math.round(Number(spend.amount) * 100))} for ${s.label} on ${spend.day}.`);
      setSpend(x => ({ ...x, amount: "" })); await load();
    }
  }

  const totals = data?.sources.reduce((t, s) => ({ leads: t.leads + s.figures.leads, spend: t.spend + s.figures.spendCents, enquired: t.enquired + s.figures.enquired, offered: t.offered + s.figures.offered }), { leads: 0, spend: 0, enquired: 0, offered: 0 });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm(f => ({ ...f, [k]: e.target.value }));
  const page = data ? Math.floor(data.offset / data.pageSize) + 1 : 1;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <main className="leads">
      <h1>Ad leads</h1>
      <p className="muted">People who filled in a Facebook, Instagram or Google ad form. Assign them to an agent and follow them through to an enquiry and an offer.</p>
      {error && <p role="alert" className="leads-msg bad">{error}</p>}
      {notice && <p role="status" className="leads-msg">{notice}</p>}
      {secret && (
        <div className="leads-secret" role="status">
          <strong>Google webhook details: copy them now, the key is not shown again.</strong>
          <dl><dt>Webhook URL</dt><dd><code>{origin}/api/webhooks/leads/google/{secret.id}</code></dd><dt>Key</dt><dd><code>{secret.key}</code></dd></dl>
          <button type="button" className="secondary" onClick={() => setSecret(null)}>Done</button>
        </div>
      )}

      <div className="leads-tabs" role="tablist" aria-label="Leads">
        <button role="tab" type="button" aria-selected={tab === "inbox"} className={tab === "inbox" ? "" : "secondary"} onClick={() => setTab("inbox")}>Inbox</button>
        <button role="tab" type="button" aria-selected={tab === "sources"} className={tab === "sources" ? "" : "secondary"} onClick={() => setTab("sources")}>Sources and spend</button>
      </div>

      <label className="leads-range">Figures for
        <select value={filter.days} onChange={e => setFilter(f => ({ ...f, days: e.target.value, offset: 0 }))}>
          <option value="7">the last 7 days</option><option value="30">the last 30 days</option><option value="90">the last 90 days</option><option value="0">all time</option>
        </select>
      </label>
      {data && totals && (
        <div className="kpis" aria-label="Totals">
          <div className="kpi"><span className="kpi-label">Leads</span><span className="kpi-value">{totals.leads}</span></div>
          <div className="kpi"><span className="kpi-label">Spend</span><span className="kpi-value">{aud(totals.spend)}</span></div>
          <div className="kpi"><span className="kpi-label">Cost per lead</span><span className="kpi-value">{totals.spend > 0 && totals.leads > 0 ? aud(Math.round(totals.spend / totals.leads)) : "—"}</span></div>
          <div className="kpi"><span className="kpi-label">Became enquiries</span><span className="kpi-value">{pct(totals.leads ? totals.enquired / totals.leads : null)}</span><span className="kpi-change">{totals.enquired} of {totals.leads}</span></div>
        </div>
      )}

      {tab === "inbox" && (
        <section aria-labelledby="inbox-h">
          <h2 id="inbox-h">Inbox</h2>
          <div className="filters">
            <label>Show <select value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value, offset: 0 }))}>
              <option value="">All leads</option><option value="unassigned">Not assigned</option>
              {LEAD_STATUSES.map(s => <option key={s} value={s}>{STATUS[s]}</option>)}<option value="enquiry">Became an enquiry</option><option value="offer">Made an offer</option>
            </select></label>
            <label>Source <select value={filter.source} onChange={e => setFilter(f => ({ ...f, source: e.target.value, offset: 0 }))}>
              <option value="">All sources</option>{data?.sources.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select></label>
          </div>
          {lost && (
            <form className="leads-lost" onSubmit={e => { e.preventDefault(); const l = data?.leads.find(x => x.id === lost.id); if (l) void setStatus(l, "lost", lost.reason.trim()); }}>
              <label>Why was this lead lost? <input value={lost.reason} onChange={e => setLost({ id: lost.id, reason: e.target.value })} maxLength={300} required autoFocus /></label>
              <div className="row-actions"><button type="submit" disabled={!!busy}>Mark lost</button><button type="button" className="secondary" onClick={() => setLost(null)}>Cancel</button></div>
            </form>
          )}
          {data === null && !error && <p className="muted" role="status">Loading…</p>}
          {data?.leads.length === 0 && <p className="empty">{filter.status || filter.source ? "No leads match these filters." : "No leads yet. Connect an ad account under Sources and spend; leads appear here as people fill in your ad forms."}</p>}
          {data && data.leads.length > 0 && (
            <div className="table-wrap"><table className="leads-table">
              <thead><tr><th>Lead</th><th>Looking for</th><th>Source</th><th>Received</th><th>Stage</th><th>Agent</th><th>Update</th></tr></thead>
              <tbody>{data.leads.map(l => {
                const st = STAGE[l.stage] ?? STAGE["new"]!;
                return (
                  <tr key={l.id}>
                    <td data-label="Lead"><span><strong>{l.name ?? "No name given"}</strong>{l.isTest && <> <span className="status-pill">Test</span></>}</span>
                      {l.email && <div><small><a href={`mailto:${l.email}`}>{l.email}</a></small></div>}{l.phone && <div><small><a href={`tel:${l.phone}`}>{l.phone}</a></small></div>}</td>
                    <td data-label="Looking for"><span>{l.interest ? INTEREST[l.interest] : "—"}</span>{(l.suburb || l.postcode) && <div><small className="muted">{[l.suburb, l.postcode].filter(Boolean).join(" ")}</small></div>}</td>
                    <td data-label="Source"><span>{l.sourceLabel}</span><div><small className="muted">{PROVIDER[l.provider]}{l.campaign ? ` · ${l.campaign}` : ""}</small></div></td>
                    <td data-label="Received"><span>{when(l.receivedAt)}</span>{l.followupStatus === "sent" && <div><small className="muted">Follow-up emailed</small></div>}</td>
                    <td data-label="Stage"><span className={`status-pill ${st.tone}`}>{st.label}</span>{l.status === "lost" && l.lostReason && <div><small className="muted">{l.lostReason}</small></div>}</td>
                    <td data-label="Agent"><select aria-label={`Agent for ${l.name ?? "lead"}`} value={l.assignedAgentId ?? ""} disabled={busy === l.id} onChange={e => assign(l, e.target.value)}>
                      <option value="">Not assigned</option>{data.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></td>
                    <td data-label="Update"><select aria-label={`Status for ${l.name ?? "lead"}`} value={l.status} disabled={busy === l.id} onChange={e => setStatus(l, e.target.value as LeadStatus)}>
                      {LEAD_STATUSES.map(s => <option key={s} value={s}>{STATUS[s]}</option>)}</select></td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
          {data && data.total > data.pageSize && (
            <nav className="leads-pager" aria-label="Pages">
              <button type="button" className="secondary" disabled={page <= 1} onClick={() => setFilter(f => ({ ...f, offset: Math.max(0, f.offset - data.pageSize) }))}>Previous</button>
              <span className="muted">Page {page} of {pages}</span>
              <button type="button" className="secondary" disabled={page >= pages} onClick={() => setFilter(f => ({ ...f, offset: f.offset + data.pageSize }))}>Next</button>
            </nav>
          )}
        </section>
      )}

      {tab === "sources" && (
        <>
          <section aria-labelledby="src-h">
            <h2 id="src-h">Sources</h2>
            <ul className="feeds-setup" aria-label="Setup"><li><span className={`status-pill ${data?.metaConfigured ? "good" : "warn"}`}>{data?.metaConfigured ? "On" : "Off"}</span> Facebook / Instagram connection <small className="muted">META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN, META_PAGE_ACCESS_TOKEN</small></li></ul>
            {data?.sources.length === 0 && <p className="empty">No ad accounts connected yet. Add a Facebook Page or a Google Ads account below.</p>}
            {data && data.sources.length > 0 && (
              <>
                <div className="table-wrap"><table className="leads-table leads-figures">
                  <thead><tr><th>Source</th><th className="num">Leads</th><th className="num">Spend</th><th className="num">Cost per lead</th><th className="num">Contacted</th><th className="num">Enquired</th><th className="num">Offer</th></tr></thead>
                  <tbody>{data.sources.map(s => (
                    <tr key={s.id}>
                      <td data-label="Source"><span><strong>{s.label}</strong>{!s.enabled && <> <span className="status-pill">Paused</span></>}</span><div><small className="muted">{PROVIDER[s.provider]} · {s.accountRef}</small></div></td>
                      <td data-label="Leads" className="num">{s.figures.leads}</td><td data-label="Spend" className="num">{aud(s.figures.spendCents)}</td>
                      <td data-label="Cost per lead" className="num">{aud(s.figures.costPerLeadCents)}</td><td data-label="Contacted" className="num">{pct(s.figures.contactRate)}</td>
                      <td data-label="Enquired" className="num">{pct(s.figures.enquiryRate)}</td><td data-label="Offer" className="num">{pct(s.figures.offerRate)}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
                <h3>Settings</h3>
                <ul className="leads-settings">{data.sources.map(s => (
                  <li key={s.id}>
                    <strong>{s.label}</strong>
                    <label>Follow-up email <select value={s.followupMode} disabled={!!busy} onChange={e => src(s, { action: "followup", mode: e.target.value })}>
                      {Object.entries(FOLLOWUP).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                    <label>Default agent <select value={s.defaultAgentId ?? ""} disabled={!!busy} onChange={e => src(s, { action: "agent", agentId: e.target.value || null })}>
                      <option value="">None</option>{data.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
                    <div className="row-actions">
                      <button type="button" className="secondary" disabled={!!busy} onClick={() => src(s, { action: s.enabled ? "pause" : "resume" })}>{s.enabled ? "Pause" : "Resume"}</button>
                      {s.provider === "google" && <button type="button" className="secondary" disabled={!!busy} onClick={() => src(s, { action: "rotate_key" })}>New key</button>}
                    </div>
                  </li>
                ))}</ul>
              </>
            )}
          </section>

          <h2>Connect an ad account</h2>
          <form className="stack feeds-form" onSubmit={onCreate}>
            <div className="feeds-grid">
              <label>Platform <select value={form.provider} onChange={set("provider")}><option value="meta">Facebook / Instagram</option><option value="google">Google Ads</option></select></label>
              <label>Name <input value={form.label} onChange={set("label")} placeholder="e.g. Paddington sellers, Facebook" minLength={2} maxLength={80} required /></label>
              <label>{form.provider === "meta" ? "Facebook Page id" : "Google Ads customer id"} <input value={form.accountRef} onChange={set("accountRef")} inputMode="numeric" placeholder={form.provider === "meta" ? "e.g. 108234567890123" : "e.g. 123-456-7890"} required /></label>
              <label>Default agent <select value={form.defaultAgentId} onChange={set("defaultAgentId")}><option value="">None (assign by hand)</option>{data?.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
              <label>Follow-up email <select value={form.followupMode} onChange={set("followupMode")}>{Object.entries(FOLLOWUP).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            </div>
            <p className="muted leads-hint">{form.provider === "meta" ? <>In Meta for Developers, subscribe the Page's <code>leadgen</code> webhook to <code>{origin}/api/webhooks/leads/meta</code>. Leads arrive within seconds.</> : <>After connecting, paste the webhook URL and key into the lead form extension's webhook settings in Google Ads.</>}</p>
            <div><button type="submit" disabled={busy === "create"}>{busy === "create" ? "Connecting…" : "Connect"}</button></div>
          </form>

          <h2>Record ad spend</h2>
          <p className="muted">Copy a day's spend from the ad account. Cost per lead is spend divided by leads over the same days.</p>
          <form className="stack feeds-form" onSubmit={onSpend}>
            <div className="feeds-grid">
              <label>Source <select value={spend.sourceId} onChange={e => setSpend(s => ({ ...s, sourceId: e.target.value }))} required><option value="">Pick a source</option>{data?.sources.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
              <label>Day <input type="date" value={spend.day} max={today()} onChange={e => setSpend(s => ({ ...s, day: e.target.value }))} required /></label>
              <label>Spend (AUD) <input type="number" min="0" max="1000000" step="0.01" inputMode="decimal" value={spend.amount} onChange={e => setSpend(s => ({ ...s, amount: e.target.value }))} required /></label>
            </div>
            <div><button type="submit" disabled={busy === "spend"}>{busy === "spend" ? "Saving…" : "Save spend"}</button></div>
          </form>
        </>
      )}
    </main>
  );
}
