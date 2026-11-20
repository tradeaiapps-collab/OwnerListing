"use client";
import { useCallback, useEffect, useState } from "react";
import type { TodayAction, TodayItem } from "../../src/domain/owner-today";
import { KIND_LABEL } from "../../src/domain/owner-today";
import { JSON_HEADERS } from "../listings/ui";
import "../styles/owner-today.css";

type State = { items: TodayItem[]; digest: { enabled: boolean } };

/** "What needs you today": real open items for the owner, each with one tap. Read fresh from the server; the server enforces ownership on every action. */
export function OwnerToday() {
  const [data, setData] = useState<State | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/owner/today");
      if (!r.ok) { setState("error"); return; }
      setData(await r.json()); setState("ready");
    } catch { setState("error"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(item: TodayItem, a: Extract<TodayAction, { type: "post" }>) {
    setBusy(item.id); setError("");
    try {
      const r = await fetch(a.url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(a.body) });
      if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "That did not work. Open it to check.");
    } catch { setError("That did not work. Try again."); } finally { setBusy(""); await load(); }
  }
  async function setDigest(enabled: boolean) {
    setBusy("digest"); setError("");
    try {
      const r = await fetch("/api/owner/today", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ digest: enabled }) });
      if (r.ok) setData(d => (d ? { ...d, digest: { enabled } } : d)); else setError("Could not change the daily email.");
    } catch { setError("Could not change the daily email."); } finally { setBusy(""); }
  }
  const act = (item: TodayItem, a: TodayAction, primary: boolean) => a.type === "link"
    ? <a className={primary ? "button" : "button secondary"} href={a.href}>{a.label}</a>
    : <button type="button" className={primary ? undefined : "secondary"} disabled={busy !== ""} onClick={() => void run(item, a)}>{busy === item.id ? "Working…" : a.label}</button>;

  return (
    <section className="ot" aria-labelledby="ot-h">
      <div className="ot-head">
        <h2 id="ot-h">What needs you today</h2>
        {state === "ready" && data && <span className="ot-count">{data.items.length === 0 ? "All clear" : `${data.items.length} open`}</span>}
      </div>
      {state === "loading" && <p className="muted" role="status">Loading…</p>}
      {state === "error" && <p role="alert">Could not load your list. <button type="button" className="link-button" onClick={() => { setState("loading"); void load(); }}>Try again</button></p>}
      {state === "ready" && data && data.items.length === 0 && (
        <p className="ot-empty">Nothing needs you right now. Elena will list anything that does, such as a buyer question, an offer or a contractor time.</p>
      )}
      {state === "ready" && data && data.items.length > 0 && (
        <ul className="ot-list">{data.items.map(i => (
          <li key={i.id} className={`ot-item ot-u${i.urgency}`}>
            <div className="ot-text">
              <span className="ot-kind">{KIND_LABEL[i.kind]}</span>
              <strong>{i.title}</strong>
              {i.detail && <span className="muted">{i.detail}</span>}
            </div>
            <div className="ot-actions">{act(i, i.action, true)}{i.more && act(i, i.more, false)}</div>
          </li>
        ))}</ul>
      )}
      {error && <p role="alert">{error}</p>}
      {state === "ready" && data && (
        <label className="ot-digest"><input type="checkbox" checked={data.digest.enabled} disabled={busy === "digest"} onChange={e => void setDigest(e.target.checked)} />
          <span>Email me this list each morning<span className="muted"> (only on days something needs you)</span></span></label>
      )}
    </section>
  );
}
