"use client";
import { useEffect, useState } from "react";
import {
  daysLeft, DELETE_REASON_MAX, DELETE_REASON_MIN, RECOVERY_DAYS, RETENTION_YEARS, retentionStage, type RetentionStage
} from "../../../../src/domain/account-deletion";
import { labelFor } from "../../../../src/domain/admin-dashboard";
import { ReasonAction } from "../../reason-action";
import { loadError, postStaff } from "../../staff-api";
import "../../../styles/admin.css";
import "../../../styles/staff.css";

interface Target {
  id: string; email: string | null; displayName: string; userType: string; status: string; deletedAt: string | null;
  listings: number; pendingOffers: number; liveOffers: number;
}
interface Deleted {
  id: string; name: string; email: string | null; userType: string; deletedAt: string; restoreUntil: string; retainUntil: string;
  deactivatedAt: string | null; purgedAt: string | null; deletedBy: string | null; reason: string | null;
  archivedListings: number; cancelledOffers: number; liveOffers: number;
}
interface Notice { text: string; held: { id: string; title: string; reasons: string[] }[] }

const day = (v: string) => new Date(v).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const STAGE: Record<RetentionStage, { label: string; pill: string }> = {
  restorable: { label: "Restorable", pill: "warn" },
  final: { label: "Final", pill: "" },
  purge_due: { label: "Removal due", pill: "bad" },
  purged: { label: "Details removed", pill: "" }
};

/**
 * Super admin only. Delete a customer account (listings archived, offers in negotiation cancelled with a notice to the other side,
 * accepted offers left to settle) and restore it within the recovery window. Records are kept for the retention period.
 */
export default function DeletedAccounts() {
  const [rows, setRows] = useState<Deleted[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date().toISOString());
  const [loaded, setLoaded] = useState(false);
  const [email, setEmail] = useState("");
  const [target, setTarget] = useState<Target | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);

  async function load(cursor?: string) {
    const p = new URLSearchParams(cursor ? { cursor } : {});
    const r = await fetch(`/api/staff/users/deleted-accounts?${p}`).catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); setLoaded(true); return; }
    const b = await r.json();
    setRows(prev => (cursor ? [...prev, ...b.accounts] : b.accounts));
    setNext(b.nextCursor); setNow(b.now); setLoaded(true);
  }
  useEffect(() => { void load(); }, []);

  async function lookup() {
    setError(""); setNotice(null); setConfirming(false); setBusy(true);
    const r = await fetch(`/api/staff/users/deleted-accounts?${new URLSearchParams({ email: email.trim() })}`).catch(() => null);
    setBusy(false);
    if (!r) { setError("Could not load."); return; }
    if (!r.ok) {
      setTarget(null);
      const b = await r.json().catch(() => ({}));
      setError(r.status === 400 || r.status === 404 ? String(b.error ?? "No customer account uses that email.") : loadError(r.status));
      return;
    }
    setTarget((await r.json()).user);
  }

  async function remove() {
    if (!target) return;
    setError(""); setBusy(true);
    const r = await postStaff("/api/staff/users/deleted-accounts", { userId: target.id, confirmEmail, reason });
    setBusy(false);
    if (!r.ok) { setError(String(r.data["error"] ?? "Could not delete.")); return; }
    const d = r.data;
    const num = (k: string) => Number(d[k] ?? 0);
    setNotice({
      held: [],
      text: `${target.email} deleted. ${plural(num("listingsArchived"), "listing")} archived, ${plural(num("offersCancelled"), "offer")} cancelled `
        + `(${num("counterpartiesNotified")} notified by email), ${plural(num("liveOffersKept"), "accepted offer")} left to settle. `
        + `It can be restored until ${day(String(d["restoreUntil"]))}. `
        + (d["accountEmailSent"] === true ? "The account holder has been emailed." : "Email is not set up or the send failed, so tell the account holder yourself.")
    });
    setTarget(null); setEmail(""); setConfirming(false); setConfirmEmail(""); setReason("");
    await load();
  }

  const afterRestore = (row: Deleted) => (d: Record<string, unknown>) => {
    const held = Array.isArray(d["listingsNotRestored"]) ? (d["listingsNotRestored"] as Notice["held"]) : [];
    setNotice({
      held,
      text: `${row.email ?? "The account"} restored as ${labelFor(String(d["status"] ?? "active")).toLowerCase()}. ${plural(Number(d["listingsBack"] ?? 0), "listing")} brought back, `
        + `${Number(d["listingsLive"] ?? 0)} live again. ${d["emailSent"] === true ? "The account holder has been emailed." : "Email is not set up or the send failed, so tell the account holder yourself."}`
        + (held.length > 0 ? ` ${plural(held.length, "listing")} stayed suspended because they would not pass the publish checks today:` : "")
    });
    void load();
  };

  const reasonLen = reason.trim().length;
  const canDelete = !busy && target !== null && target.email !== null && confirmEmail.trim().toLowerCase() === target.email.toLowerCase()
    && reasonLen >= DELETE_REASON_MIN && reasonLen <= DELETE_REASON_MAX;

  return (
    <main className="admin-page deleted-accounts">
      <h1>Deleted accounts</h1>
      <p><a href="/staff/users">Back to user accounts</a></p>
      <p className="muted">
        Deleting an owner, agent or buyer account signs them out at once and archives their listings. Offers still being negotiated are
        cancelled and the other side is emailed; accepted offers carry on to settlement. Within {RECOVERY_DAYS} days you can restore the
        account. Offer, payment and audit records are kept for {RETENTION_YEARS} years, then the name and email are removed. Only super
        admins can do this, and every step is logged.
      </p>

      <section aria-labelledby="delete-heading">
        <h2 id="delete-heading">Delete an account</h2>
        <p className="staff-notice">Check who asked for this and why before you delete. The account holder is emailed with the restore deadline.</p>
        <form className="filters" onSubmit={e => { e.preventDefault(); void lookup(); }}>
          <label>Account email
            <input type="email" value={email} autoComplete="off" required maxLength={254} placeholder="name@example.com" onChange={e => setEmail(e.target.value)} />
          </label>
          <button type="submit" disabled={busy || email.trim().length === 0}>{busy && !confirming ? "Looking up…" : "Look up"}</button>
        </form>
      </section>

      {notice && (
        <div role="status" className="admin-notice">
          <p>{notice.text}</p>
          {notice.held.length > 0 && <ul>{notice.held.map(h => <li key={h.id}><strong>{h.title}</strong>: {h.reasons.join(" ")}</li>)}</ul>}
        </div>
      )}
      {error && <p role="alert">{error}</p>}

      {target && (
        <section className="account-detail" aria-label="Account to delete">
          <h2>{target.displayName || "Unnamed account"} <span className="status-pill">{labelFor(target.status)}</span></h2>
          <p className="muted">{labelFor(target.userType)} · {target.email ?? "No email"} · id {target.id}</p>
          {target.deletedAt
            ? <p>This account was deleted on {day(target.deletedAt)}. Find it in the list below.</p>
            : target.status === "closed"
              ? <p>This account is already closed.</p>
              : (
                <>
                  <h3>What deleting it does</h3>
                  <ul>
                    <li>{plural(target.listings, "listing")} archived (hidden from the site, brought back if restored)</li>
                    <li>{plural(target.pendingOffers, "offer")} in negotiation cancelled, and the other side emailed</li>
                    <li>{plural(target.liveOffers, "accepted offer")} left to settle as agreed</li>
                  </ul>
                  {!confirming
                    ? <div className="row-actions"><button type="button" className="danger" onClick={() => { setConfirming(true); setError(""); }}>Delete account</button></div>
                    : (
                      <form className="stack-tight" onSubmit={e => { e.preventDefault(); void remove(); }}>
                        <h3>Confirm the deletion</h3>
                        <p>The account is signed out at once. Cancelled offers stay cancelled even if the account is restored.</p>
                        <label>Type the account email to confirm
                          <input type="email" value={confirmEmail} autoComplete="off" onChange={e => setConfirmEmail(e.target.value)} placeholder={target.email ?? ""} required />
                        </label>
                        <label>Reason (kept in the audit log, {DELETE_REASON_MIN} to {DELETE_REASON_MAX} characters)
                          <textarea className="staff-reason" value={reason} maxLength={DELETE_REASON_MAX} onChange={e => setReason(e.target.value)} required />
                        </label>
                        <div className="row-actions">
                          <button type="submit" className="danger" disabled={!canDelete}>{busy ? "Deleting…" : "Delete account"}</button>
                          <button type="button" className="secondary" onClick={() => { setConfirming(false); setConfirmEmail(""); setReason(""); }}>Cancel</button>
                        </div>
                      </form>
                    )}
                </>
              )}
        </section>
      )}

      <h2>Deleted accounts</h2>
      {!loaded && <p className="muted" aria-live="polite">Loading…</p>}
      {loaded && rows.length === 0 && !error && <p className="empty">No accounts have been deleted.</p>}
      {rows.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr>
            <th scope="col">Account</th><th scope="col">Deleted</th><th scope="col">Stage</th><th scope="col">What changed</th>
            <th scope="col"><span className="sr-only">Restore</span></th>
          </tr></thead>
          <tbody>
            {rows.map(r => {
              const stage = retentionStage({ restoreUntil: r.restoreUntil, retainUntil: r.retainUntil, deactivatedAt: r.deactivatedAt, purgedAt: r.purgedAt }, now);
              return (
                <tr key={r.id}>
                  <td><strong>{r.purgedAt ? "Details removed" : r.name || "Unnamed"}</strong><br /><span className="muted">{labelFor(r.userType)}{r.email ? ` · ${r.email}` : ""}</span></td>
                  <td>{day(r.deletedAt)}{r.deletedBy ? <><br /><span className="muted">by {r.deletedBy}</span></> : null}{r.reason ? <><br /><span className="muted">{r.reason}</span></> : null}</td>
                  <td>
                    <span className={`status-pill ${STAGE[stage].pill}`}>{STAGE[stage].label}</span>
                    <br /><span className="muted">{stage === "restorable" ? `${plural(daysLeft(r.restoreUntil, now), "day")} left` : "Not restorable"}</span>
                    <br /><span className="muted">Records kept to {day(r.retainUntil)}</span>
                  </td>
                  <td>
                    {plural(r.archivedListings, "listing")} archived<br />
                    <span className="muted">{plural(r.cancelledOffers, "offer")} cancelled<br />{plural(r.liveOffers, "accepted offer")} kept</span>
                  </td>
                  <td>
                    {stage === "restorable"
                      ? <ReasonAction label="Restore account" action="restore" url={`/api/staff/users/deleted-accounts/${r.id}`} onDone={afterRestore(r)} />
                      : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
      {next && <button type="button" className="secondary" onClick={() => void load(next)}>Load more</button>}
    </main>
  );
}
