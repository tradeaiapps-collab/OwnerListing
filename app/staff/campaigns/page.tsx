"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError, postStaff } from "../staff-api";
import "../../styles/admin.css";
import "../../styles/automation.css";

interface Stats { recipients: number; sent: number; failed: number; skipped: number; pending: number; opened: number; clicked: number; openRate: number; clickRate: number }
interface Campaign { id: string; name: string; channel: "email" | "sms"; segment: string; subject: string | null; status: string; scheduledAt: string | null; stats: Stats }
const SEGMENTS: Record<string, string> = { all_agents: "All agents", all_owners: "All owners", all_buyers: "All buyers", buyers_in_area: "Buyers searching in an area" };
const STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"];
const BLANK = { name: "", channel: "email", segment: "all_agents", state: "", suburbs: "", subject: "", body: "", ctaUrl: "", scheduledAt: "" };
const STATUS: Record<string, string> = { draft: "Draft", scheduled: "Scheduled", sending: "Sending", sent: "Sent", cancelled: "Cancelled" };
const when = (v: string | null) => (v ? new Date(v).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" }) : "");

/**
 * Bulk email and SMS campaigns. Only people who opted in to marketing on the chosen channel are reached, and email always carries a one-click
 * unsubscribe link. Open and click rates come from a tracking pixel and a tracked link; opens are an undercount where mail apps block images.
 */
export default function StaffCampaigns() {
  const [rows, setRows] = useState<Campaign[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [f, setF] = useState(BLANK);
  const [audience, setAudience] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/campaigns").catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
    setRows((await r.json()).campaigns); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const payload = () => ({
    name: f.name, channel: f.channel, segment: f.segment,
    segmentConfig: f.segment === "buyers_in_area" ? { state: f.state, suburbs: f.suburbs.split(",").map(s => s.trim()).filter(Boolean) } : {},
    subject: f.channel === "email" ? f.subject : undefined, body: f.body, ctaUrl: f.ctaUrl, scheduledAt: f.scheduledAt ? new Date(f.scheduledAt).toISOString() : ""
  });
  const set = (k: keyof typeof BLANK) => (e: { target: { value: string } }) => { setF({ ...f, [k]: e.target.value }); setAudience(null); };

  async function preview() {
    setBusy(true); setError("");
    const r = await postStaff("/api/staff/campaigns", { ...payload(), action: "preview" });
    setBusy(false);
    if (!r.ok) { setError(String(r.data["error"] ?? "Could not count.")); return; }
    setAudience(Number(r.data["audience"]));
  }
  async function create() {
    setBusy(true); setError(""); setNotice("");
    const r = await postStaff("/api/staff/campaigns", payload());
    setBusy(false);
    if (!r.ok) { setError(String(r.data["error"] ?? "Could not save.")); return; }
    setNotice(f.scheduledAt ? "Campaign scheduled." : "Saved as a draft. Send it now or schedule it from the list."); setF(BLANK); setAudience(null); await load();
  }
  async function move(id: string, action: "send" | "unschedule" | "cancel" | "schedule", scheduledAt?: string) {
    setBusy(true); setError(""); setNotice("");
    const r = await postStaff(`/api/staff/campaigns/${id}`, { action, scheduledAt });
    setBusy(false);
    if (!r.ok) { setError(String(r.data["error"] ?? "Could not change the campaign.")); return; }
    setNotice(action === "send" ? "Sending starts within 15 minutes." : action === "cancel" ? "Campaign cancelled." : action === "schedule" ? "Campaign scheduled." : "Campaign is a draft again."); await load();
  }

  return (
    <main className="admin-page automation">
      <h1>Campaigns</h1>
      <p><a href="/staff/dashboard">Back to the admin dashboard</a></p>
      <p className="muted">
        Send an email or text to a group. Only people who turned on marketing messages for that channel are reached (SMS also needs a verified mobile).
        The list is fixed when sending starts, and anyone who opts out before their message goes is skipped. Sending runs in batches every 15 minutes.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {loaded && rows.length === 0 && <p className="empty">No campaigns yet.</p>}
      {rows.length > 0 && (
        <div className="table-wrap"><table className="au-table">
          <thead><tr><th scope="col" className="au-wide">Campaign</th><th scope="col" className="au-num">Sent</th><th scope="col" className="au-num">Opened</th><th scope="col" className="au-num">Clicked</th></tr></thead>
          <tbody>{rows.map(c => (
            <tr key={c.id}>
              <td><strong>{c.name}</strong><br /><span className="muted">{c.channel === "email" ? "Email" : "SMS"} to {SEGMENTS[c.segment]?.toLowerCase()}{c.channel === "email" && c.subject ? `. ${c.subject}` : ""}</span><br /><span className={`status-pill ${c.status === "sent" ? "good" : c.status === "cancelled" ? "bad" : ""}`}>{STATUS[c.status] ?? c.status}</span>{c.scheduledAt && c.status === "scheduled" && <><br /><span className="muted">{when(c.scheduledAt)}</span></>}<div className="row-actions">
                {(c.status === "draft" || c.status === "scheduled") && <button type="button" disabled={busy} onClick={() => void move(c.id, "send")}>Send now</button>}
                {c.status === "scheduled" && <button type="button" className="secondary" disabled={busy} onClick={() => void move(c.id, "unschedule")}>Unschedule</button>}
                {(c.status === "draft" || c.status === "scheduled" || c.status === "sending") && <button type="button" className="danger" disabled={busy} onClick={() => void move(c.id, "cancel")}>Cancel</button>}
              </div></td>
              <td className="au-num">{c.stats.sent}{c.stats.recipients > 0 && <><br /><span className="muted">of {c.stats.recipients}</span></>}{c.stats.failed > 0 && <><br /><span className="muted">{c.stats.failed} failed</span></>}</td>
              <td className="au-num">{c.channel === "email" && c.stats.sent > 0 ? <>{c.stats.openRate}%<br /><span className="muted">{c.stats.opened}</span></> : <span className="muted">n/a</span>}</td>
              <td className="au-num">{c.stats.sent > 0 ? <>{c.stats.clickRate}%<br /><span className="muted">{c.stats.clicked}</span></> : <span className="muted">n/a</span>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}

      <details className="au-add" open={rows.length === 0 && loaded}>
        <summary>New campaign</summary>
        <form className="stack" onSubmit={e => { e.preventDefault(); void create(); }}>
          <label>Name (for staff)<input required minLength={3} maxLength={120} value={f.name} onChange={set("name")} /></label>
          <label>Channel<select value={f.channel} onChange={set("channel")}><option value="email">Email</option><option value="sms">SMS (Twilio)</option></select></label>
          <label>Send to<select value={f.segment} onChange={set("segment")}>{Object.entries(SEGMENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          {f.segment === "buyers_in_area" && <>
            <label>State<select value={f.state} onChange={set("state")}><option value="">Any</option>{STATES.map(s => <option key={s}>{s}</option>)}</select></label>
            <label>Suburbs (comma separated)<input maxLength={600} value={f.suburbs} onChange={set("suburbs")} /></label>
          </>}
          {f.channel === "email" && <label>Subject<input required maxLength={150} value={f.subject} onChange={set("subject")} /></label>}
          <label>Button or link (optional)<input maxLength={300} placeholder="https://… or /listings" value={f.ctaUrl} onChange={set("ctaUrl")} /></label>
          <label>Send later (optional)<input type="datetime-local" value={f.scheduledAt} onChange={set("scheduledAt")} /></label>
          <label>{f.channel === "sms" ? "Text (up to 2 SMS segments)" : "Message"}<textarea required maxLength={f.channel === "sms" ? 320 : 1500} value={f.body} onChange={set("body")} /></label>
          <p className="muted au-full au-help">{audience === null ? "Check how many people this would reach before you send." : `This would reach ${audience} ${audience === 1 ? "person" : "people"} right now.`}</p>
          <button type="button" className="secondary" disabled={busy} onClick={() => void preview()}>Count recipients</button>
          <button type="submit" disabled={busy}>{busy ? "Saving…" : f.scheduledAt ? "Schedule campaign" : "Save draft"}</button>
        </form>
      </details>
    </main>
  );
}
