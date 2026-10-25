"use client";
import { useEffect, useState } from "react";
import { labelFor } from "../../../src/domain/admin-dashboard";
import { ReasonAction } from "../reason-action";
import { loadError } from "../staff-api";
import "../../styles/admin.css";

interface Row {
  id: string; name: string; email: string | null; userType: string; status: string; createdAt: string; listings: number;
  emailVerified: boolean; phoneVerified: boolean; idVerified: boolean; licence: string; openCases: number; notes: string[];
}
interface Detail { user: Row & { termsCurrent: boolean }; history: { occurredAt: string; eventType: string; reason: string | null }[] }
const TYPES = ["owner", "agent", "buyer", "vendor", "project_owner", "investor"];
const STATUSES = ["active", "suspended", "pending", "closed"];
const pill = (s: string) => (s === "active" ? "good" : s === "suspended" ? "bad" : s === "pending" ? "warn" : "");
const yes = (b: boolean) => (b ? "Yes" : "No");

/** User accounts with their verification and compliance facts. Suspend or reinstate with a reason. Staff accounts are not listed here. */
export default function UserAccounts() {
  const [f, setF] = useState({ q: "", userType: "", status: "" });
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [open, setOpen] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  async function load(cursor?: string) {
    setError("");
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    if (cursor) p.set("cursor", cursor);
    const r = await fetch(`/api/staff/users?${p}`).catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
    const b = await r.json();
    setRows(prev => (cursor ? [...prev, ...b.users] : b.users));
    setNext(b.nextCursor); setFull(b.fullDetails === true); setLoaded(true);
  }
  async function details(id: string) {
    const r = await fetch(`/api/staff/users/${id}`).catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
    setOpen(await r.json());
  }
  const refresh = async (id: string) => { await load(); await details(id); };
  useEffect(() => { void load(); }, []);

  const sel = (k: "userType" | "status", label: string, opts: string[]) => (
    <label>{label}
      <select value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })}>
        <option value="">All</option>{opts.map(o => <option key={o} value={o}>{labelFor(o)}</option>)}
      </select>
    </label>
  );

  return (
    <main className="admin-page">
      <h1>User accounts</h1>
      <p><a href="/staff/dashboard">Back to the admin dashboard</a></p>
      <p className="muted">
        A suspended account is signed out on its next request and cannot sign back in until reinstated. Its listings stay as they are; suspend a
        listing separately in Listing moderation. {full ? "You can see full names and emails." : "Names and emails are partly hidden for your role; search by account id."}
      </p>
      <form className="filters" onSubmit={e => { e.preventDefault(); void load(); }}>
        <label>Search <input value={f.q} placeholder={full ? "Name, email or account id" : "Account id"} onChange={e => setF({ ...f, q: e.target.value })} /></label>
        {sel("userType", "Type", TYPES)}{sel("status", "Status", STATUSES)}
        <button type="submit">Search</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {open && (
        <section className="account-detail" aria-label="Account details">
          <h2>{open.user.name || "Unnamed account"} <span className={`status-pill ${pill(open.user.status)}`}>{labelFor(open.user.status)}</span></h2>
          <p className="muted">{labelFor(open.user.userType)} · {open.user.email ?? "No email"} · joined {new Date(open.user.createdAt).toLocaleDateString("en-AU")} · id {open.user.id}</p>
          <ul>
            <li>Email verified: {yes(open.user.emailVerified)}; phone verified: {yes(open.user.phoneVerified)}; ID verified: {yes(open.user.idVerified)}</li>
            {open.user.userType === "agent" && <li>Agent licence: {open.user.licence}</li>}
            <li>Current terms accepted: {yes(open.user.termsCurrent)}</li>
            <li>Listings: {open.user.listings}; open admin cases: {open.user.openCases}</li>
          </ul>
          {open.user.notes.length > 0 ? <><strong>Needs attention</strong><ul className="notes">{open.user.notes.map(n => <li key={n}>{n}</li>)}</ul></> : <p>Nothing outstanding.</p>}
          {open.history.length > 0 && (
            <><h3>Suspension history</h3><ul>{open.history.map(h => <li key={h.occurredAt}>{new Date(h.occurredAt).toLocaleString("en-AU")}: {h.eventType === "user.suspended" ? "Suspended" : "Reinstated"}{h.reason ? `, ${h.reason}` : ""}</li>)}</ul></>
          )}
          <div className="row-actions">
            {open.user.status === "active" && <ReasonAction label="Suspend account" action="suspend" danger url={`/api/staff/users/${open.user.id}/action`} onDone={() => void refresh(open.user.id)} />}
            {open.user.status === "suspended" && <ReasonAction label="Reinstate account" action="reinstate" url={`/api/staff/users/${open.user.id}/action`} onDone={() => void refresh(open.user.id)} />}
            <button type="button" className="secondary" onClick={() => setOpen(null)}>Close</button>
          </div>
        </section>
      )}
      {loaded && rows.length === 0 && <p className="empty">No accounts match.</p>}
      {rows.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th scope="col">Account</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Needs attention</th><th scope="col">Listings</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td><strong>{r.name || "Unnamed"}</strong><br /><span className="muted">{r.email ?? "No email"}</span></td>
                <td>{labelFor(r.userType)}</td>
                <td><span className={`status-pill ${pill(r.status)}`}>{labelFor(r.status)}</span></td>
                <td>{r.notes.length === 0 ? <span className="muted">Nothing</span> : <ul className="notes">{r.notes.map(n => <li key={n}>{n}</li>)}</ul>}</td>
                <td>{r.listings}</td>
                <td><button type="button" className="secondary" onClick={() => void details(r.id)}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {next && <button type="button" className="secondary" onClick={() => void load(next)}>Load more</button>}
    </main>
  );
}
