"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError, postStaff } from "../staff-api";

interface Inspector { userId: string; name: string; email: string; businessName: string; licenceRef: string; jurisdictions: string[]; status: string; reviewNote: string; createdAt: string }
interface Booking { id: string; listingTitle: string; buyerName: string; inspectorName?: string; inspectionId?: string; slots: string[]; status: string; scheduledAt?: string; createdAt: string }
const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
const BOOKING_LABEL: Record<string, string> = { pending_inspector_response: "Waiting for inspector", scheduled: "Scheduled", completed: "Completed", cancelled: "Cancelled" };
const INSPECTOR_LABEL: Record<string, string> = { pending: "Pending", approved: "Approved", rejected: "Rejected", suspended: "Suspended" };

/** Staff page: approve, reject or suspend inspectors and watch every inspection request. Needs user.manage. */
export default function StaffInspections() {
  const [inspectors, setInspectors] = useState<Inspector[] | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [reason, setReason] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const r = await fetch(`/api/staff/inspections${filter ? `?bookings=${filter}` : ""}`).catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
    const d = await r.json() as { inspectors: Inspector[]; bookings: Booking[] };
    setInspectors(d.inspectors); setBookings(d.bookings);
  }, [filter]);
  useEffect(() => { void load(); }, [load]);

  async function decide(userId: string, decision: "approved" | "rejected" | "suspended") {
    setBusy(userId); setError(""); setNote("");
    const r = await postStaff("/api/staff/inspections", { userId, decision, note: reason[userId] ?? "" });
    setBusy("");
    if (!r.ok) { setError(String(r.data["error"] ?? "Could not save.")); return; }
    setNote(`Inspector ${decision}.`); await load();
  }

  return (
    <main className="admin-page">
      <h1>Inspections</h1>
      <p className="muted">Inspectors must be approved before they can see requests. A rejection or suspension needs a short reason that the inspector sees.</p>
      <div aria-live="polite">{error && <p role="alert">{error}</p>}{note && <p role="status">{note}</p>}</div>
      {!inspectors && !error && <p className="muted" role="status">Loading…</p>}

      {inspectors && (<>
        <h2>Inspectors</h2>
        {inspectors.length === 0 ? <p className="empty">No inspector applications yet.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th scope="col">Inspector</th><th scope="col">States</th><th scope="col">Status</th><th scope="col">Decision</th></tr></thead>
            <tbody>
              {inspectors.map(i => (
                <tr key={i.userId}>
                  <td><strong>{i.businessName}</strong><br /><span className="muted">{i.name} · {i.email}{i.licenceRef ? ` · ${i.licenceRef}` : ""}</span></td>
                  <td>{i.jurisdictions.join(", ")}</td>
                  <td>{INSPECTOR_LABEL[i.status] ?? i.status}{i.reviewNote ? <><br /><span className="muted">{i.reviewNote}</span></> : null}</td>
                  <td>
                    <label className="muted">Reason<input value={reason[i.userId] ?? ""} maxLength={500} onChange={e => setReason({ ...reason, [i.userId]: e.target.value })} /></label>
                    <div className="actions">
                      {i.status !== "approved" && <button type="button" disabled={busy === i.userId} onClick={() => decide(i.userId, "approved")}>Approve</button>}
                      {i.status === "pending" && <button type="button" className="secondary" disabled={busy === i.userId} onClick={() => decide(i.userId, "rejected")}>Reject</button>}
                      {i.status === "approved" && <button type="button" className="secondary" disabled={busy === i.userId} onClick={() => decide(i.userId, "suspended")}>Suspend</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}

        <h2>Requests</h2>
        <div className="filters"><label>Status
          <select value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="">All</option>
            {Object.entries(BOOKING_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label></div>
        {bookings.length === 0 ? <p className="empty">No inspection requests.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th scope="col">Property</th><th scope="col">Buyer</th><th scope="col">Inspector</th><th scope="col">Status</th><th scope="col">When</th></tr></thead>
            <tbody>
              {bookings.map(b => (
                <tr key={b.id}>
                  <td>{b.listingTitle}</td><td>{b.buyerName}</td><td>{b.inspectorName ?? "Not yet"}</td>
                  <td>{BOOKING_LABEL[b.status] ?? b.status}</td>
                  <td>{b.scheduledAt ? when(b.scheduledAt) : `Asked ${when(b.createdAt)}`}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </>)}
    </main>
  );
}
