"use client";
import { useEffect, useState, type FormEvent } from "react";
import { PASSWORD_MIN, isSelfSignupType, type SelfSignupType } from "../../src/domain/email-auth";
import { safeNext } from "../../src/server/auth/safe-next";
import { AuthCard, GoogleButton, OrDivider, errorOf, loadProviders, postJson, type Providers } from "../login/auth-ui";
import "../styles/auth.css";

const ROLES: { id: SelfSignupType; title: string; text: string }[] = [
  { id: "buyer", title: "Buying or renting", text: "Save searches, get alerts and make offers." },
  { id: "owner", title: "Owner", text: "List your own home for sale or rent." },
  { id: "agent", title: "Agent", text: "Work on listings owners appoint you to. Needs a verified licence." }
];

/** Open sign-up for buyers, owners and agents, with Google or with email and password (confirmed by a link before the account exists). */
export default function Signup() {
  const [providers, setProviders] = useState<Providers | null>(null);
  const [next, setNext] = useState<string | undefined>();
  const [role, setRole] = useState<SelfSignupType>("buyer");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setNext(safeNext(q.get("next")));
    const a = q.get("as");
    if (isSelfSignupType(a)) setRole(a);
    void loadProviders().then(setProviders);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg("");
    const r = await postJson("/api/auth/password/signup", { name, email, password, userType: role });
    setBusy(false);
    if (r.ok) setSentTo(email.trim());
    else setMsg(errorOf(r.d, "Could not create your account. Try again."));
  };

  if (sentTo) {
    return (
      <AuthCard title="Check your email" foot={<>Wrong address? <button type="button" className="auth-link" onClick={() => setSentTo(null)}>Start again</button></>}>
        <p>We sent a link to <strong className="auth-email">{sentTo}</strong>. Open it on this device to finish creating your account.</p>
        <p className="muted">The link expires in 24 hours. Nothing arrived after a few minutes? Check your spam folder.</p>
      </AuthCard>
    );
  }

  const googleHref = `/api/auth/google/start?as=${role}${next ? `&next=${encodeURIComponent(next)}` : ""}`;
  return (
    <AuthCard title="Create your account" lead="Free to join. Choose what you are here to do; you can still browse everything."
      foot={<>Already have an account? <a href={`/login${next ? `?next=${encodeURIComponent(next)}` : ""}`}>Sign in</a></>}>
      <fieldset className="auth-roles">
        <legend>I am</legend>
        {ROLES.map(r => (
          <label key={r.id} className="auth-role">
            <input type="radio" name="role" value={r.id} checked={role === r.id} onChange={() => setRole(r.id)} />
            <span><strong>{r.title}</strong><span className="auth-role-text">{r.text}</span></span>
          </label>
        ))}
      </fieldset>
      {(role === "owner" || role === "agent") && <p className="auth-note">Owner and agent accounts also set up a second sign-in step (an authenticator app or a text message) right after joining.</p>}
      {providers === null ? <p className="muted" role="status">Loading…</p> : (
        <>
          {providers.google && <GoogleButton href={googleHref} label="Sign up with Google" />}
          {providers.google && providers.email && <OrDivider />}
          {providers.email && (
            <form className="auth-form" onSubmit={submit}>
              <label className="field">
                Full name
                <input value={name} onChange={e => setName(e.target.value)} autoComplete="name" required minLength={2} maxLength={80} />
              </label>
              <label className="field">
                Email
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" inputMode="email" required maxLength={254} />
              </label>
              <label className="field">
                Password
                <span className="auth-password">
                  <input type={show ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" required
                    minLength={PASSWORD_MIN} maxLength={128} aria-describedby="pw-hint" />
                  <button type="button" className="secondary" onClick={() => setShow(s => !s)} aria-pressed={show}>{show ? "Hide" : "Show"}</button>
                </span>
                <span className="hint" id="pw-hint">At least {PASSWORD_MIN} characters. A short phrase is easy to remember.</span>
              </label>
              {msg && <p role="alert">{msg}</p>}
              <button type="submit" disabled={busy}>{busy ? "Creating account…" : "Create account"}</button>
            </form>
          )}
          {!providers.google && !providers.email && <p role="alert">Sign-up is not available right now. Try again shortly.</p>}
        </>
      )}
      <p className="auth-terms">By creating an account you agree to the <a href="/terms">Terms and Conditions</a>, including the investment risk warning.</p>
    </AuthCard>
  );
}
