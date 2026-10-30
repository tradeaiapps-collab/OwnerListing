"use client";
import { useEffect, useState, type FormEvent } from "react";
import { isSelfSignupType } from "../../src/domain/email-auth";
import { safeNext } from "../../src/server/auth/safe-next";
import { AuthCard, GoogleButton, OrDivider, errorOf, loadProviders, postJson, type Providers } from "./auth-ui";
import "../styles/auth.css";

/** Sign in with Google or with email and password. Owners and agents (and anyone with a second step set up) go on to /mfa. */
export default function Login() {
  const [providers, setProviders] = useState<Providers | null>(null);
  const [next, setNext] = useState<string | undefined>();
  const [as, setAs] = useState<string | undefined>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [msg, setMsg] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setNext(safeNext(q.get("next")));
    const a = q.get("as");
    if (isSelfSignupType(a)) setAs(a);
    void loadProviders().then(setProviders);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(""); setFailed(false);
    const r = await postJson("/api/auth/password/login", { email, password, ...(next ? { next } : {}) });
    if (r.ok && typeof r.d["redirect"] === "string") { window.location.assign(r.d["redirect"]); return; }
    setBusy(false);
    setFailed(r.d["code"] === "bad_credentials");
    setMsg(errorOf(r.d, "Could not sign you in. Try again."));
  };

  const qs = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...(next ? { next } : {}), ...extra })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : "";
  };

  return (
    <AuthCard title="Sign in" lead="Welcome back. Sign in to manage your listings, offers and saved searches."
      foot={<>New here? <a href={`/signup${qs({ as })}`}>Create an account</a></>}>
      {providers === null ? <p className="muted" role="status">Loading…</p> : (
        <>
          {providers.google && <GoogleButton href={`/api/auth/google/start${qs({ as })}`} label="Continue with Google" />}
          {providers.google && providers.email && <OrDivider />}
          {providers.email && (
            <form className="auth-form" onSubmit={submit} noValidate={false}>
              <label className="field">
                Email
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" inputMode="email" required maxLength={254} />
              </label>
              <label className="field">
                <span className="auth-label-row">Password <a href={`/forgot-password${email ? `?email=${encodeURIComponent(email)}` : ""}`}>Forgot password?</a></span>
                <span className="auth-password">
                  <input type={show ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required maxLength={128}
                    aria-invalid={failed || undefined} />
                  <button type="button" className="secondary" onClick={() => setShow(s => !s)} aria-pressed={show}>{show ? "Hide" : "Show"}</button>
                </span>
              </label>
              {msg && <p role="alert">{msg}</p>}
              <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
            </form>
          )}
          {!providers.google && !providers.email && <p role="alert">Sign-in is not available right now. Try again shortly.</p>}
        </>
      )}
    </AuthCard>
  );
}
