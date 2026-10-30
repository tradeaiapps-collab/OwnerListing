"use client";
import { useEffect, useState, type FormEvent } from "react";
import { PASSWORD_MIN } from "../../src/domain/email-auth";
import { AuthCard, errorOf, postJson } from "../login/auth-ui";
import "../styles/auth.css";

/** Sets a new password from a reset link. Every existing session ends; two-step sign-in stays as it was. */
export default function ResetPassword() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => { setToken(new URLSearchParams(window.location.search).get("token") ?? ""); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg("");
    const r = await postJson("/api/auth/password/reset", { token, password });
    setBusy(false);
    if (r.ok) setDone(true);
    else setMsg(errorOf(r.d, "Could not change your password. Try again."));
  };

  if (token === null) return <AuthCard title="Choose a new password"><p className="muted" role="status">Loading…</p></AuthCard>;
  if (!token) return <AuthCard title="Choose a new password"><p role="alert">This link is not complete. <a href="/forgot-password">Ask for a new one</a>.</p></AuthCard>;
  if (done) {
    return (
      <AuthCard title="Password changed" lead="You have been signed out everywhere. Sign in with your new password.">
        <a className="button auth-wide" href="/login">Sign in</a>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Choose a new password" foot={<a href="/login">Back to sign in</a>}>
      <form className="auth-form" onSubmit={submit}>
        <label className="field">
          New password
          <span className="auth-password">
            <input type={show ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" required
              minLength={PASSWORD_MIN} maxLength={128} aria-describedby="pw-hint" />
            <button type="button" className="secondary" onClick={() => setShow(s => !s)} aria-pressed={show}>{show ? "Hide" : "Show"}</button>
          </span>
          <span className="hint" id="pw-hint">At least {PASSWORD_MIN} characters.</span>
        </label>
        {msg && <p role="alert">{msg} {/expired|not valid|no longer/.test(msg) && <a href="/forgot-password">Ask for a new link</a>}</p>}
        <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save new password"}</button>
      </form>
    </AuthCard>
  );
}
