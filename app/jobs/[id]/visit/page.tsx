"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ACCESS_LABELS, ACCESS_METHODS, COMPLAINT_KINDS, NEEDS_DETAILS, type AccessMethod } from "../../../../src/domain/contractor-ops";
import "../../../styles/contractor-ops.css";

type Visit = { startsAt: string; endsAt: string; state: "proposed" | "confirmed"; proposedBy: string; attendees: string[] };
type Job = { visit: Visit | null; canConfirm: boolean; role: "owner" | "contractor"; status: string; kind: string; address: string | null };
type Access = { method: AccessMethod; label: string; hasDetails: boolean; details: string | null; masked: boolean } | null;
type Notice = { id: string; tenantName: string; windowStartsAt: string; windowEndsAt: string; status: string; sentAt: string };
type Overlap = { startsAt: string; endsAt: string };

const fmt = (iso: string) => new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const toIso = (local: string) => (local ? new Date(local).toISOString() : "");
const KIND_LABELS: Record<string, string> = { no_show: "Did not turn up", poor_work: "Poor work", late: "Late", conduct: "Conduct", other: "Something else" };

async function call(method: string, url: string, body?: unknown) {
  const r = await fetch(url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }).catch(() => null);
  if (!r) return { ok: false, status: 0, data: { error: "Network error. Try again." } as Record<string, unknown> };
  return { ok: r.ok, status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

/** One job: its time, who attends, how the contractor gets in, the tenant's entry notice and any problem report. Both parties use this page; each sees only their side. */
export default function JobVisit() {
  const { id } = useParams<{ id: string }>();
  const base = `/api/assignments/${id}`;
  const [job, setJob] = useState<Job | null>(null);
  const [access, setAccess] = useState<Access>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [loadError, setLoadError] = useState("");
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [overlaps, setOverlaps] = useState<Overlap[] | null>(null);
  const [pending, setPending] = useState<"propose" | "confirm">("propose");
  const [busy, setBusy] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [who, setWho] = useState<string[]>([]);
  const [method, setMethod] = useState<AccessMethod>("owner_present");
  const [details, setDetails] = useState("");
  const [tenant, setTenant] = useState({ name: "", email: "", start: "", end: "" });
  const [complaint, setComplaint] = useState({ kind: "no_show", details: "" });

  const load = useCallback(async () => {
    setLoadError("");
    const j = await call("GET", `${base}/visit`);
    if (!j.ok) { setLoadError(j.status === 401 ? "Sign in to see this job." : j.status === 404 ? "Job not found." : "Could not load this job."); return; }
    const jb = j.data as unknown as Job;
    setJob(jb);
    const a = await call("GET", `${base}/access`);
    if (a.ok) { const acc = a.data["access"] as Access; setAccess(acc); if (acc) setMethod(acc.method); }
    if (jb.role === "owner") { const n = await call("GET", `${base}/tenant-notice`); if (n.ok) setNotices(n.data["notices"] as Notice[]); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<{ ok: boolean; status: number; data: Record<string, unknown> }>, done: string, after?: () => void, action: "propose" | "confirm" = "propose") {
    setBusy(true); setMsg(null);
    const r = await fn();
    setBusy(false);
    if (r.ok) { setMsg({ text: done, bad: false }); setOverlaps(null); after?.(); await load(); }
    else if (r.status === 409 && r.data["code"] === "overlap") { setOverlaps(r.data["overlaps"] as Overlap[]); setPending(action); setMsg({ text: String(r.data["error"]), bad: true }); }
    else setMsg({ text: String(r.data["error"] ?? "Something went wrong."), bad: true });
  }
  const propose = (ack = false) => run(() => call("PUT", `${base}/visit`, { startsAt: toIso(start), endsAt: toIso(end), attendees: who, acknowledgeOverlap: ack }), "Time sent for confirmation.");
  const confirm = (ack = false) => run(() => call("POST", `${base}/visit`, { action: "confirm", acknowledgeOverlap: ack }), "Time confirmed.", undefined, "confirm");
  const toggle = (a: string) => setWho(w => (w.includes(a) ? w.filter(x => x !== a) : [...w, a]));

  if (loadError) return <main className="co"><h1>Job</h1><p role="alert" className="co-error">{loadError}</p></main>;
  if (!job) return <main className="co"><h1>Job</h1><p className="co-state" role="status">Loading…</p></main>;

  const isOwner = job.role === "owner";
  const open = job.status === "proposed" || job.status === "approved";
  const v = job.visit;

  return (
    <main className="co">
      <div>
        <h1>Visit and access</h1>
        <p className="muted">{job.kind} · {job.status === "approved" ? "Accepted" : job.status === "proposed" ? "Waiting for the contractor" : job.status === "completed" ? "Completed" : "Cancelled"}{job.address ? ` · ${job.address}` : ""}</p>
      </div>
      {msg && <p role={msg.bad ? "alert" : "status"} className={msg.bad ? "co-error" : "co-ok"}>{msg.text}</p>}
      {overlaps && (
        <div className="co-warn" role="alert">
          <p>This overlaps {overlaps.length === 1 ? "another job" : `${overlaps.length} other jobs`} you have accepted: {overlaps.map(o => `${fmt(o.startsAt)} to ${fmt(o.endsAt).split(", ").pop()}`).join("; ")}.</p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => void (pending === "confirm" ? confirm(true) : propose(true))}>Go ahead anyway</button>
            <button type="button" className="secondary" onClick={() => setOverlaps(null)}>Choose another time</button>
          </div>
        </div>
      )}

      <section className="co-section" aria-labelledby="co-time">
        <h2 id="co-time">Time</h2>
        {v ? (
          <>
            <p><span className={`co-badge ${v.state === "confirmed" ? "ok" : "warn"}`}>{v.state === "confirmed" ? "Confirmed" : "Waiting for confirmation"}</span></p>
            <p>{fmt(v.startsAt)} to {fmt(v.endsAt).split(", ").pop()}</p>
            <p className="muted">Attending: {v.attendees.length ? v.attendees.join(", ") : "nobody recorded"}</p>
            {job.canConfirm && <div className="actions"><button type="button" disabled={busy} onClick={() => void confirm()}>Confirm this time</button></div>}
          </>
        ) : <p className="muted">No time has been set yet.</p>}
        {open && (
          <form className="stack" onSubmit={e => { e.preventDefault(); void propose(); }}>
            <div className="co-row">
              <label>Starts<input type="datetime-local" value={start} onChange={e => setStart(e.target.value)} required /></label>
              <label>Ends<input type="datetime-local" value={end} onChange={e => setEnd(e.target.value)} required /></label>
            </div>
            <fieldset>
              <legend>Who will be there</legend>
              {["owner", "agent", "tenant"].map(a => <label key={a} className="co-check"><input type="checkbox" checked={who.includes(a)} onChange={() => toggle(a)} /> {a[0]!.toUpperCase() + a.slice(1)}</label>)}
            </fieldset>
            <p className="muted">Times are in your device's time zone. The other side confirms before it is set.</p>
            <div className="actions"><button type="submit" className="secondary" disabled={busy || !start || !end}>{v ? "Propose a different time" : "Propose a time"}</button></div>
          </form>
        )}
      </section>

      <section className="co-section" aria-labelledby="co-access">
        <h2 id="co-access">How to get in</h2>
        {access ? (
          <>
            <p><strong>{access.label}</strong></p>
            {access.details && <p className="co-secret">{access.details}</p>}
            {access.masked && <p className="muted">Key and lockbox details are shown once you accept the job, and are hidden again when it is finished.</p>}
          </>
        ) : <p className="muted">{isOwner ? "You have not said how the contractor gets in yet." : "The owner has not said how to get in yet."}</p>}
        {isOwner && open && (
          <form className="stack" onSubmit={e => { e.preventDefault(); void run(() => call("PUT", `${base}/access`, { method, details }), "Access saved.", () => setDetails("")); }}>
            <label>Method
              <select value={method} onChange={e => setMethod(e.target.value as AccessMethod)}>
                {ACCESS_METHODS.map(m => <option key={m} value={m}>{ACCESS_LABELS[m]}</option>)}
              </select>
            </label>
            {NEEDS_DETAILS.has(method) && <label>{method === "lockbox" ? "Lockbox code and where it is" : "Where to collect the key"}<input value={details} onChange={e => setDetails(e.target.value)} maxLength={500} required autoComplete="off" /></label>}
            <p className="muted">Details are stored encrypted and only shown to this contractor while the job is accepted.</p>
            <div className="actions"><button type="submit" className="secondary" disabled={busy}>Save access</button></div>
          </form>
        )}
      </section>

      {isOwner && job.status === "approved" && (
        <section className="co-section" aria-labelledby="co-tenant">
          <h2 id="co-tenant">Tell the tenant</h2>
          <p className="muted">For a rental, email the tenant the entry window at least 24 hours before. Check your state's rules on entry notice. We log every notice.</p>
          {notices.length === 0 ? <p className="muted">No notice sent yet.</p> : (
            <ul className="co-list">{notices.map(n => <li key={n.id} className="co-item"><div className="co-item-head"><strong>{n.tenantName}</strong><span className={`co-badge ${n.status === "sent" ? "ok" : "warn"}`}>{n.status === "sent" ? "Sent" : "Failed"}</span></div><p>{fmt(n.windowStartsAt)} to {fmt(n.windowEndsAt).split(", ").pop()}</p></li>)}</ul>
          )}
          <form className="stack" onSubmit={e => { e.preventDefault(); void run(() => call("POST", `${base}/tenant-notice`, { tenantName: tenant.name, tenantEmail: tenant.email, startsAt: toIso(tenant.start), endsAt: toIso(tenant.end) }), "Notice sent.", () => setTenant({ name: "", email: "", start: "", end: "" })); }}>
            <div className="co-row">
              <label>Tenant's name<input value={tenant.name} onChange={e => setTenant({ ...tenant, name: e.target.value })} maxLength={100} required /></label>
              <label>Tenant's email<input type="email" value={tenant.email} onChange={e => setTenant({ ...tenant, email: e.target.value })} maxLength={254} required /></label>
              <label>Entry from<input type="datetime-local" value={tenant.start} onChange={e => setTenant({ ...tenant, start: e.target.value })} required /></label>
              <label>Entry until<input type="datetime-local" value={tenant.end} onChange={e => setTenant({ ...tenant, end: e.target.value })} required /></label>
            </div>
            <div className="actions"><button type="submit" disabled={busy}>Send notice</button></div>
          </form>
        </section>
      )}

      {isOwner && (job.status === "approved" || job.status === "completed") && (
        <section className="co-section" aria-labelledby="co-problem">
          <h2 id="co-problem">Report a problem</h2>
          <p className="muted">Tell us if the contractor did not turn up or the work was not right. Staff can see this.</p>
          <form className="stack" onSubmit={e => { e.preventDefault(); void run(() => call("POST", `${base}/complaint`, complaint), "Thanks. We have recorded it.", () => setComplaint({ kind: "no_show", details: "" })); }}>
            <label>What happened
              <select value={complaint.kind} onChange={e => setComplaint({ ...complaint, kind: e.target.value })}>{COMPLAINT_KINDS.map(k => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}</select>
            </label>
            <label>Details<textarea value={complaint.details} onChange={e => setComplaint({ ...complaint, details: e.target.value })} maxLength={2000} rows={4} required /></label>
            <div className="actions"><button type="submit" className="secondary" disabled={busy}>Send report</button></div>
          </form>
        </section>
      )}
    </main>
  );
}
