"use client";
import { useState } from "react";

export interface DevAccount { id: string; name: string; email: string; kind: string; note: string }

export default function DevLoginButtons({ accounts }: { accounts: DevAccount[] }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const go = async (id: string) => {
    setBusy(id); setError("");
    const r = await fetch("/api/dev/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: id }) });
    const d = (await r.json().catch(() => ({}))) as { redirect?: string; error?: string };
    if (r.ok && d.redirect) { window.location.href = d.redirect; return; }
    setError(d.error ?? `Sign-in failed (${r.status}).`); setBusy("");
  };
  return (
    <div>
      {error && <p role="alert">{error}</p>}
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
        {accounts.map(a => (
          <li key={a.id}>
            <button className="button" disabled={busy !== ""} onClick={() => go(a.id)}>
              {a.name} <small>({a.kind}{a.note ? `, ${a.note}` : ""})</small>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
