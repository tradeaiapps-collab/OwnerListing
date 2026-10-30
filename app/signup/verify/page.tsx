"use client";
import { useEffect, useState } from "react";
import { AuthCard, errorOf, postJson } from "../../login/auth-ui";
import "../../styles/auth.css";

/**
 * Finishes email sign-up. The link only opens this page; the account is created when the person presses the button, so a mail
 * scanner that follows links cannot use up the one-time link.
 */
export default function VerifyEmail() {
  const [token, setToken] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [exists, setExists] = useState(false);

  useEffect(() => { setToken(new URLSearchParams(window.location.search).get("token") ?? ""); }, []);

  const confirm = async () => {
    setBusy(true); setMsg("");
    const r = await postJson("/api/auth/password/verify", { token });
    if (r.ok && typeof r.d["redirect"] === "string") { window.location.assign(r.d["redirect"]); return; }
    setBusy(false);
    setExists(r.d["code"] === "account_exists");
    setMsg(errorOf(r.d, "Could not confirm your email. Try again."));
  };

  if (token === null) return <AuthCard title="Confirm your email"><p className="muted" role="status">Loading…</p></AuthCard>;
  if (!token) return <AuthCard title="Confirm your email"><p role="alert">This link is not complete. Open it again from your email, or <a href="/signup">sign up again</a>.</p></AuthCard>;
  return (
    <AuthCard title="Confirm your email" lead="One last step: confirm this is your email address to create your account.">
      <button type="button" className="auth-wide" onClick={() => void confirm()} disabled={busy}>{busy ? "Creating your account…" : "Confirm and continue"}</button>
      {msg && <p role="alert">{msg} {exists ? <a href="/login">Sign in</a> : <a href="/signup">Sign up again</a>}</p>}
    </AuthCard>
  );
}
