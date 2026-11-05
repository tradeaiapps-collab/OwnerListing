"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { SEVERITIES, type Severity } from "../../../../src/domain/inspection";
import { JSON_HEADERS } from "../../ui";
import TxnAssistant from "../txn-assistant";
import "../../../styles/transaction.css";

type Finding = { severity: Severity; area: string; summary: string; recommendation?: string };
type Summary = { headline: string; nextSteps: string[] };
type Insp = {
  id: string; kind: string; status: string; scheduledStart: string; durationMinutes: number; inspectorUserId?: string; buyerUserId?: string;
  accessNotes?: string; cancelReason?: string; findings: Finding[]; summary: Summary | null;
};
type Party = { userId: string; name: string; role: "buyer" | "inspector" };
type Data = { role: "owner" | "agent" | "inspector" | "buyer"; kinds: { id: string; label: string }[]; inspections: Insp[]; parties: Party[] };

const when = (iso: string) => new Intl.DateTimeFormat("en-AU", { dateStyle: "full", timeStyle: "short" }).format(new Date(iso));
const STATUS: Record<string, string> = { requested: "Waiting for the inspector", confirmed: "Confirmed", completed: "Completed", cancelled: "Cancelled" };
const blank = (): Finding => ({ severity: "minor", area: "", summary: "", recommendation: "" });

export default function InspectionsPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [bump, setBump] = useState(0);
  const [completing, setCompleting] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[]>([blank()]);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    setLoadError("");
    const r = await fetch(`/api/listings/${id}/inspections`, { credentials: "same-origin" }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (r?.ok) setData(d);
    else setLoadError(!r ? "Could not load inspections." : r.status === 401 ? "Sign in to see inspections." : r.status === 404 ? "Listing not found." : d.error ?? "Could not load inspections.");
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const handler = data?.role === "owner" || data?.role === "agent";
  const nameOf = (uid?: string) => (uid ? data?.parties.find(p => p.userId === uid)?.name ?? "Assigned" : undefined);

  async function schedule(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const local = String(fd.get("start") ?? "");
    const ms = Date.parse(local);
    setBusy(true); setError(""); setNotice("");
    const body = {
      kind: fd.get("kind"), scheduledStart: Number.isFinite(ms) ? new Date(ms).toISOString() : "", durationMinutes: Number(fd.get("duration")),
      inspectorUserId: fd.get("inspector") || undefined, buyerUserId: fd.get("buyer") || undefined, accessNotes: String(fd.get("notes") ?? "").trim() || undefined
    };
    const r = await fetch(`/api/listings/${id}/inspections`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (r?.ok) { form.reset(); setNotice("Booked. Confirmation emails are on their way."); await load(); setBump(b => b + 1); } else setError(d.error ?? "Could not book the inspection.");
  }

  async function act(inspectionId: string, action: "confirm" | "cancel" | "complete") {
    setBusy(true); setError(""); setNotice("");
    const body: Record<string, unknown> = { action };
    if (action === "cancel" && reason.trim()) body["reason"] = reason.trim();
    if (action === "complete") body["findings"] = findings.filter(f => f.area.trim() || f.summary.trim()).map(f => ({ ...f, recommendation: f.recommendation?.trim() || undefined }));
    const r = await fetch(`/api/inspections/${inspectionId}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (r?.ok) {
      setNotice({ confirm: "Confirmed.", cancel: "Cancelled.", complete: "Completed. The findings are on record." }[action]);
      setCompleting(null); setCancelling(null); setReason(""); setFindings([blank()]);
      await load(); setBump(b => b + 1);
    } else setError(d.error ?? "Could not update the inspection.");
  }

  const setF = (i: number, patch: Partial<Finding>) => setFindings(fs => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const open = (i: Insp) => i.status === "requested" || i.status === "confirmed";

  return (
    <main>
      <h1>Inspections</h1>
      <p className="muted">Book building, pest and other inspections and walkthroughs. Everyone involved gets a confirmation and a reminder the day before.</p>
      {loadError ? <p role="alert" className="tx-err">{loadError}</p> : null}
      {!loadError && !data ? <p className="muted" role="status">Loading…</p> : null}
      {data && (
        <div className="tx-layout">
          <div className="tx-main">
            {error ? <p role="alert" className="tx-err">{error}</p> : null}
            {notice ? <p role="status" className="tx-ok">{notice}</p> : null}

            {handler && (
              <section aria-labelledby="book-title" className="panel">
                <h2 id="book-title">Book an inspection</h2>
                <form className="tx-form" onSubmit={schedule}>
                  <div className="tx-row">
                    <label>Type<select name="kind" required defaultValue="building">{data.kinds.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}</select></label>
                    <label>Length<select name="duration" defaultValue="60">{[30, 45, 60, 90, 120, 180, 240].map(m => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}`}</option>)}</select></label>
                  </div>
                  <label>Date and time<input type="datetime-local" name="start" required /></label>
                  <div className="tx-row">
                    <label>Inspector<select name="inspector" defaultValue=""><option value="">None (walkthrough)</option>{data.parties.filter(p => p.role === "inspector").map(p => <option key={p.userId} value={p.userId}>{p.name}</option>)}</select>
                      <span className="tx-hint">Inspectors you have approved on the <a href={`/listings/${id}/assignments`}>assignments page</a>.</span></label>
                    <label>Buyer attending<select name="buyer" defaultValue=""><option value="">No one yet</option>{data.parties.filter(p => p.role === "buyer").map(p => <option key={p.userId} value={p.userId}>{p.name}</option>)}</select>
                      <span className="tx-hint">Buyers who have enquired.</span></label>
                  </div>
                  <label>Access notes <span className="tx-hint">(optional, up to 500 characters)</span><textarea name="notes" maxLength={500} /></label>
                  <div className="actions"><button type="submit" disabled={busy}>{busy ? "Booking…" : "Book inspection"}</button></div>
                </form>
              </section>
            )}

            <section aria-labelledby="list-title">
              <h2 id="list-title">{handler ? "All inspections" : "Your inspections"}</h2>
              {data.inspections.length === 0 ? <p className="empty">No inspections yet.{handler ? " Book one above." : ""}</p> : (
                <ul className="card-list">
                  {data.inspections.map(i => {
                    const startPassed = Date.parse(i.scheduledStart) <= Date.now();
                    const canConfirm = i.status === "requested" && (i.inspectorUserId ? data.role === "inspector" : handler);
                    const canComplete = i.status === "confirmed" && startPassed && (i.inspectorUserId ? data.role === "inspector" || handler : handler);
                    return (
                      <li key={i.id}>
                        <div className="tx-head">
                          <h3>{data.kinds.find(k => k.id === i.kind)?.label ?? i.kind}</h3>
                          <span className={`badge badge-${i.status}`}>{STATUS[i.status] ?? i.status}</span>
                        </div>
                        <p><strong>{when(i.scheduledStart)}</strong> · {i.durationMinutes} minutes</p>
                        <p className="tx-meta">
                          {nameOf(i.inspectorUserId) && <span>Inspector: {nameOf(i.inspectorUserId)}</span>}
                          {nameOf(i.buyerUserId) && <span>Buyer: {nameOf(i.buyerUserId)}</span>}
                        </p>
                        {i.accessNotes ? <p className="muted">Access: {i.accessNotes}</p> : null}
                        {i.cancelReason ? <p className="muted">Reason: {i.cancelReason}</p> : null}
                        {open(i) && (
                          <div className="actions">
                            {canConfirm && <button type="button" disabled={busy} onClick={() => void act(i.id, "confirm")}>Confirm</button>}
                            {canComplete && <button type="button" disabled={busy} onClick={() => { setCompleting(i.id); setCancelling(null); }}>Complete and add findings</button>}
                            <button type="button" className="secondary" disabled={busy} onClick={() => { setCancelling(i.id); setCompleting(null); }}>Cancel</button>
                          </div>
                        )}
                        {cancelling === i.id && (
                          <div className="tx-form">
                            <label>Reason (optional)<input value={reason} maxLength={300} onChange={e => setReason(e.target.value)} /></label>
                            <div className="actions"><button type="button" className="danger" disabled={busy} onClick={() => void act(i.id, "cancel")}>Cancel this inspection</button><button type="button" className="secondary" onClick={() => setCancelling(null)}>Keep it</button></div>
                          </div>
                        )}
                        {completing === i.id && (
                          <div className="tx-form" role="group" aria-label="Findings">
                            <p className="muted">Add what was found. Findings are kept as a permanent record. Leave empty if nothing was found.</p>
                            {findings.map((f, n) => (
                              <div className="tx-find" key={n}>
                                <div className="tx-row">
                                  <label>How serious<select value={f.severity} onChange={e => setF(n, { severity: e.target.value as Severity })}>{SEVERITIES.map(s => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}</select></label>
                                  <label>Area<input value={f.area} maxLength={80} onChange={e => setF(n, { area: e.target.value })} placeholder="Roof, wiring, bathroom…" /></label>
                                </div>
                                <label>What was found<textarea value={f.summary} maxLength={500} onChange={e => setF(n, { summary: e.target.value })} /></label>
                                <label>Recommendation (optional)<input value={f.recommendation ?? ""} maxLength={500} onChange={e => setF(n, { recommendation: e.target.value })} /></label>
                                {findings.length > 1 && <button type="button" className="secondary" onClick={() => setFindings(fs => fs.filter((_, j) => j !== n))}>Remove this finding</button>}
                              </div>
                            ))}
                            <div className="actions">
                              <button type="button" className="secondary" disabled={findings.length >= 50} onClick={() => setFindings(fs => [...fs, blank()])}>Add another finding</button>
                              <button type="button" disabled={busy} onClick={() => void act(i.id, "complete")}>Save and complete</button>
                              <button type="button" className="secondary" onClick={() => setCompleting(null)}>Not now</button>
                            </div>
                          </div>
                        )}
                        {i.status === "completed" && i.summary && (
                          <div>
                            <p><strong>{i.summary.headline}</strong></p>
                            {i.findings.length > 0 && (
                              <div className="table-wrap">
                                <table className="tx-table">
                                  <thead><tr><th scope="col">Severity</th><th scope="col">Area</th><th scope="col">Finding</th><th scope="col">Recommendation</th></tr></thead>
                                  <tbody>{i.findings.map((f, n) => (
                                    <tr key={n}><td data-label="Severity"><span className={`tx-sev ${f.severity}`}>{f.severity}</span></td><td data-label="Area">{f.area}</td><td data-label="Finding">{f.summary}</td><td data-label="Recommendation">{f.recommendation ?? "—"}</td></tr>
                                  ))}</tbody>
                                </table>
                              </div>
                            )}
                            {i.summary.nextSteps.length > 0 && <ul>{i.summary.nextSteps.map(s => <li key={s}>{s}</li>)}</ul>}
                            {handler && <p className="muted"><small>Upload the inspector&apos;s report on the <a href={`/listings/${id}/documents`}>documents page</a> to share it.</small></p>}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            <p><a href={`/listings/${id}/transaction`}>Documents and signing</a> · <a href={`/listings/${id}/documents`}>Uploaded files</a></p>
          </div>
          <aside className="tx-aside"><TxnAssistant listingId={id} refreshKey={bump} /></aside>
        </div>
      )}
    </main>
  );
}
