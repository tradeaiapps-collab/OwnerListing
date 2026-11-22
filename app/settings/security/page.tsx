"use client";
import { useEffect, useState } from "react";

interface Profile { email: string | null; hasPassword: boolean; hasGoogle: boolean }

export default function SecurityPage() {
  const [state, setState] = useState<"loading" | "out" | "error" | "ok">("loading");
  const [p, setP] = useState<Profile | null>(null);
  useEffect(() => {
    fetch("/api/me/profile")
      .then(async r => {
        if (r.status === 401) return setState("out");
        if (!r.ok) return setState("error");
        setP((await r.json()) as Profile); setState("ok");
      })
      .catch(() => setState("error"));
  }, []);

  if (state === "loading") return <main><p className="muted" role="status">Loading…</p></main>;
  if (state === "out") return <main><h1>Email and password</h1><div className="empty-state"><p>Sign in to see your sign-in details.</p><a className="button" href="/login?next=/settings/security">Sign in</a></div></main>;
  if (state === "error" || !p) return <main><h1>Email and password</h1><p role="alert">Could not load your details. Try again shortly.</p></main>;
  const googleOnly = p.hasGoogle && !p.hasPassword;
  return (
    <main>
      <h1>Email and password</h1>
      <section className="acct-card" aria-labelledby="acct-email-h">
        <h2 id="acct-email-h">Sign-in details</h2>
        <dl>
          <dt>Email</dt><dd>{p.email ?? "Not set"}</dd>
          <dt>Sign-in</dt><dd>{[p.hasGoogle ? "Google" : null, p.hasPassword ? "Email and password" : null].filter(Boolean).join(" and ") || "Not set"}</dd>
        </dl>
        {googleOnly
          ? <p className="muted">Your email and password are managed by Google. Change them in your Google account.</p>
          : <p className="muted">To change your password, <a href="/forgot-password">send yourself a reset link</a>. This signs you out everywhere.</p>}
      </section>
      <section className="acct-card" aria-labelledby="acct-mfa-h">
        <h2 id="acct-mfa-h">Two-step sign-in</h2>
        <p className="muted">Add an authenticator app or text message, and keep your recovery codes safe.</p>
        <a className="button" href="/mfa">Manage two-step sign-in</a>
      </section>
    </main>
  );
}
