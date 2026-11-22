"use client";
import { useEffect, useState } from "react";
import { JSON_HEADERS } from "../listings/ui";

interface Profile { displayName: string; email: string | null; hasPassword: boolean; hasGoogle: boolean }

export default function ProfilePage() {
  const [state, setState] = useState<"loading" | "out" | "error" | "ok">("loading");
  const [p, setP] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/me/profile")
      .then(async r => {
        if (r.status === 401) return setState("out");
        if (!r.ok) return setState("error");
        const d = (await r.json()) as Profile;
        setP(d); setName(d.displayName); setState("ok");
      })
      .catch(() => setState("error"));
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(""); setOk(false);
    const r = await fetch("/api/me/profile", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ displayName: name }) }).catch(() => null);
    setBusy(false);
    if (!r) return setMsg("Could not save. Check your connection and try again.");
    const d = (await r.json().catch(() => ({}))) as { error?: string; displayName?: string };
    if (!r.ok || !d.displayName) return setMsg(d.error ?? "Could not save. Please try again.");
    setName(d.displayName); setP(p ? { ...p, displayName: d.displayName } : p); setOk(true); setMsg("Saved.");
  };

  if (state === "loading") return <main><p className="muted" role="status">Loading…</p></main>;
  if (state === "out") return <main><h1>Account</h1><div className="empty-state"><p>Sign in to see your account.</p><a className="button" href="/login?next=/settings">Sign in</a></div></main>;
  if (state === "error" || !p) return <main><h1>Account</h1><p role="alert">Could not load your profile. Try again shortly.</p></main>;
  return (
    <main>
      <h1>Profile</h1>
      <section className="acct-card" aria-labelledby="acct-name-h">
        <h2 id="acct-name-h">Your name</h2>
        <form onSubmit={save}>
          <label>
            Name
            <input value={name} onChange={e => { setName(e.target.value); setMsg(""); }} maxLength={80} autoComplete="name" required />
          </label>
          {msg ? <p role={ok ? "status" : "alert"}>{msg}</p> : null}
          <button type="submit" disabled={busy || name.trim() === p.displayName}>{busy ? "Saving…" : "Save name"}</button>
        </form>
      </section>
      <section className="acct-card" aria-labelledby="acct-photo-h">
        <h2 id="acct-photo-h">Photo</h2>
        <p className="muted">Profile photos are coming soon. They need file storage and a security review first.</p>
      </section>
    </main>
  );
}
