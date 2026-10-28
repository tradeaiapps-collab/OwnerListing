"use client";
import { useState } from "react";
import { labelFor } from "../../../../src/domain/admin-dashboard";
import { MFA_RESET_REASON_MAX, MFA_RESET_REASON_MIN } from "../../../../src/domain/mfa-reset";
import { loadError, postStaff } from "../../staff-api";
import "../../../styles/admin.css";
import "../../../styles/staff.css";

interface Account {
  id: string; email: string; displayName: string; userType: string; status: string; liveMethods: number; recoveryCodesLeft: number;
  methods: { kind: string; label: string; addedAt: string; lastUsedAt: string | null }[];
  resets: { resetAt: string; reason: string; methodsRevoked: number; resetBy: string }[];
}
const pill = (s: string) => (s === "active" ? "good" : s === "suspended" ? "bad" : s === "pending" ? "warn" : "");
const when = (v: string) => new Date(v).toLocaleString("en-AU");

/** Super admin only. Find an owner or agent by email and reset their two-step sign-in after a lost phone. */
export default function MfaReset() {
  const [email, setEmail] = useState("");
  const [account, setAccount] = useState<Account | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function lookup(address = email, keepNotice = false) {
    setError(""); if (!keepNotice) setNotice(""); setConfirming(false); setBusy(true);
    const r = await fetch(`/api/staff/security/mfa-reset?${new URLSearchParams({ email: address.trim() })}`).catch(() => null);
    setBusy(false);
    if (!r) { setError("Could not load."); return; }
    if (!r.ok) {
      setAccount(null);
      const b = await r.json().catch(() => ({}));
      setError(r.status === 400 || r.status === 404 ? String(b.error ?? "No account uses that email.") : loadError(r.status));
      return;
    }
    setAccount((await r.json()).user);
  }

  async function reset() {
    if (!account) return;
    setError(""); setBusy(true);
    const r = await postStaff("/api/staff/security/mfa-reset", { userId: account.id, confirmEmail, reason });
    setBusy(false);
    if (!r.ok) { setError(String(r.data["error"] ?? "Could not reset.")); return; }
    const n = Number(r.data["methodsRevoked"] ?? 0);
    setConfirming(false); setConfirmEmail(""); setReason("");
    await lookup(account.email, true);
    setNotice(`Two-step sign-in reset for ${account.email}. ${n} method${n === 1 ? "" : "s"} removed and every session signed out. `
      + (r.data["emailSent"] === true ? "The user has been emailed." : "Email is not set up or the send failed, so tell the user yourself."));
  }

  const reasonLen = reason.trim().length;
  const canSubmit = !busy && account !== null && confirmEmail.trim().toLowerCase() === account.email.toLowerCase()
    && reasonLen >= MFA_RESET_REASON_MIN && reasonLen <= MFA_RESET_REASON_MAX;

  return (
    <main className="admin-page">
      <h1>Two-step sign-in reset</h1>
      <p className="muted">
        For an owner or agent who has lost the phone or authenticator app they use to sign in. A reset removes every sign-in method and
        recovery code and signs them out everywhere. They then sign in with Google using their verified email and must set up a new phone
        or app before they can do anything else. Only super admins can do this, and every lookup and reset is logged.
      </p>
      <p className="staff-notice">Check who you are talking to before you reset. Confirm their identity the same way you would for any account change.</p>

      <form className="filters" onSubmit={e => { e.preventDefault(); void lookup(); }}>
        <label>Account email
          <input type="email" value={email} autoComplete="off" required maxLength={254} placeholder="name@example.com" onChange={e => setEmail(e.target.value)} />
        </label>
        <button type="submit" disabled={busy || email.trim().length === 0}>{busy && !confirming ? "Looking up…" : "Look up"}</button>
      </form>

      {notice && <div role="status" className="admin-notice"><p>{notice}</p></div>}
      {error && <p role="alert">{error}</p>}

      {account && (
        <section className="account-detail" aria-label="Account">
          <h2>{account.displayName || "Unnamed account"} <span className={`status-pill ${pill(account.status)}`}>{labelFor(account.status)}</span></h2>
          <p className="muted">{labelFor(account.userType)} · {account.email} · id {account.id}</p>

          <h3>Sign-in methods</h3>
          {account.methods.length === 0
            ? <p className="empty">{account.liveMethods > 0 ? "A method is being set up but is not confirmed yet." : "No two-step sign-in method. Nothing to reset."}</p>
            : (
              <ul>
                {account.methods.map(m => <li key={`${m.kind}-${m.addedAt}`}>{m.label}, added {when(m.addedAt)}{m.lastUsedAt ? `, last used ${when(m.lastUsedAt)}` : ""}</li>)}
                <li>Recovery codes left: {account.recoveryCodesLeft}</li>
              </ul>
            )}

          {account.resets.length > 0 && (
            <>
              <h3>Past resets</h3>
              <ul>{account.resets.map(r => <li key={r.resetAt}>{when(r.resetAt)} by {r.resetBy}: {r.reason}</li>)}</ul>
            </>
          )}

          {account.liveMethods > 0 && account.userType !== "admin" && (
            !confirming
              ? <div className="row-actions"><button type="button" className="danger" onClick={() => { setConfirming(true); setError(""); setNotice(""); }}>Reset MFA</button></div>
              : (
                <form className="stack-tight" onSubmit={e => { e.preventDefault(); void reset(); }}>
                  <h3>Confirm the reset</h3>
                  <p>This cannot be undone. The user&rsquo;s current phone, authenticator app and recovery codes stop working at once.</p>
                  <label>Type the account email to confirm
                    <input type="email" value={confirmEmail} autoComplete="off" onChange={e => setConfirmEmail(e.target.value)} placeholder={account.email} required />
                  </label>
                  <label>Reason (kept in the audit log, {MFA_RESET_REASON_MIN} to {MFA_RESET_REASON_MAX} characters)
                    <textarea className="staff-reason" value={reason} maxLength={MFA_RESET_REASON_MAX} onChange={e => setReason(e.target.value)} required />
                  </label>
                  <div className="row-actions">
                    <button type="submit" className="danger" disabled={!canSubmit}>{busy ? "Resetting…" : "Reset two-step sign-in"}</button>
                    <button type="button" className="secondary" onClick={() => { setConfirming(false); setConfirmEmail(""); setReason(""); }}>Cancel</button>
                  </div>
                </form>
              )
          )}
          {account.userType === "admin" && <p className="muted">Staff accounts are not reset here.</p>}
        </section>
      )}
    </main>
  );
}
