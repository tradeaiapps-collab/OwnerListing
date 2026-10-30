"use client";
import { useEffect, useState, type FormEvent } from "react";
import { AuthCard, errorOf, postJson } from "../login/auth-ui";
import "../styles/auth.css";

/** Asks for a reset link. Always answers the same way, so it never tells anyone whether an address has an account. */
export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => { setEmail(new URLSearchParams(window.location.search).get("email") ?? ""); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg("");
    const r = await postJson("/api/auth/password/forgot", { email });
    setBusy(false);
    if (r.ok) setSent(true);
    else setMsg(errorOf(r.d, "Could not send the link. Try again."));
  };

  if (sent) {
    return (
      <AuthCard title="Check your email" foot={<a href="/login">Back to sign in</a>}>
        <p>If <strong className="auth-email">{email.trim()}</strong> has an account, we have sent it a link to choose a new password. The link expires in 60 minutes.</p>
        <p className="muted">Signed up with Google? You can keep using Google, or use the link to add a password too.</p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Reset your password" lead="Enter the email you signed up with and we will send you a link to choose a new password."
      foot={<>Remembered it? <a href="/login">Sign in</a></>}>
      <form className="auth-form" onSubmit={submit}>
        <label className="field">
          Email
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" inputMode="email" required maxLength={254} />
        </label>
        {msg && <p role="alert">{msg}</p>}
        <button type="submit" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
      </form>
    </AuthCard>
  );
}
