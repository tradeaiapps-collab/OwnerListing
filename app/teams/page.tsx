"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { JSON_HEADERS } from "../listings/ui";

type TeamRow = { id: string; name: string; kind: "team" | "office"; role: string; memberCount: number };

/** An agent's teams and offices, with a form to start a new one. */
export default function TeamsPage() {
  const [teams, setTeams] = useState<TeamRow[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("team");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const r = await fetch("/api/teams");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return setLoadError(r.status === 401 ? "Sign in to see your teams." : d.error ?? "Could not load your teams.");
      setTeams(d.teams);
    } catch {
      setLoadError("Could not load your teams.");
    }
  }
  useEffect(() => { void load(); }, []);

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/teams", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name, kind }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setName(""); await load(); } else setMsg(d.error ?? "Could not create the team.");
    } catch {
      setMsg("Could not create the team.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="team-page">
      <h1>Teams and offices</h1>
      <p className="muted">Run your agency here: add people, share out tasks, set commission splits and see how the team is doing.</p>
      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && teams === null && <p className="muted" role="status">Loading…</p>}
      {teams && teams.length === 0 && <p className="muted">You are not on a team yet. Create one below, or ask your manager to add your email.</p>}
      {teams && teams.length > 0 && (
        <ul className="team-cards">
          {teams.map(t => (
            <li key={t.id} className="team-card">
              <h2><Link href={`/teams/${t.id}`}>{t.name}</Link></h2>
              <p className="muted">{t.kind === "office" ? "Office" : "Team"} · {t.memberCount} {t.memberCount === 1 ? "person" : "people"} · You are {t.role === "agent" ? "an agent" : `a ${t.role}`}</p>
            </li>
          ))}
        </ul>
      )}
      <form className="stack team-form" onSubmit={onCreate}>
        <h2>Start a team or office</h2>
        <label>Name
          <input value={name} onChange={e => setName(e.target.value)} minLength={2} maxLength={80} required placeholder="North Brisbane office" />
        </label>
        <label>Type
          <select value={kind} onChange={e => setKind(e.target.value)}>
            <option value="team">Team</option>
            <option value="office">Office</option>
          </select>
        </label>
        <p className="muted">Only agent accounts can start a team. You become its manager.</p>
        <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create"}</button>
        {msg && <p role="alert">{msg}</p>}
      </form>
    </main>
  );
}
