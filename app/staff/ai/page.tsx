"use client";
import { useCallback, useEffect, useState } from "react";
import "../../styles/staff.css";
import { loadError, postStaff } from "../staff-api";

interface Entry { enabled: boolean; reason: string; changedBy: string; changedAt: string }
interface View {
  enabled: boolean; configured: boolean; effective: boolean;
  engine?: string; model?: string; endpoint?: string; configState?: string; problem?: string;
  history: Entry[];
}

const OUTCOME: Record<string, string> = {
  ok: "Connected. The model is installed and ready.",
  model_missing: "The server answers, but the model is not installed. On that computer run: ollama pull <model>.",
  unreachable: "The model server did not answer. Is Ollama running?",
  not_configured: "The server has no AI engine configured."
};

export default function StaffAi() {
  const [view, setView] = useState<View | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/ai").catch(() => null);
    if (!r) { setError("Could not load."); return; }
    if (!r.ok) { setError(loadError(r.status)); return; }
    setView(await r.json());
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggle(enabled: boolean) {
    setError(""); setNote(""); setBusy(true);
    const r = await postStaff("/api/staff/ai", { enabled, reason });
    setBusy(false);
    if (r.ok) { setView(r.data as unknown as View); setReason(""); setNote(enabled ? "AI switched on." : "AI switched off."); }
    else setError(String(r.data["error"] ?? "Could not save."));
  }

  async function test() {
    setError(""); setNote(""); setBusy(true);
    const r = await postStaff("/api/staff/ai/test", {});
    setBusy(false);
    const outcome = String(r.data["outcome"] ?? "");
    if (r.ok && outcome === "ok") setNote(OUTCOME["ok"]!);
    else setError(OUTCOME[outcome] ?? String(r.data["error"] ?? "Test failed."));
  }

  return (
    <main>
      <h1>AI engine</h1>
      <p className="muted">The AI runs on our own model server, never an outside AI service. It only writes suggestions that a person checks; it never accepts or declines offers. Default: off.</p>
      {view && (
        <section className="stack">
          <h2>Status</h2>
          <p>Switch: <strong>{view.enabled ? "On" : "Off"}</strong>. AI in use now: <strong>{view.effective ? "Yes" : "No"}</strong>.</p>
          {view.configured
            ? <p>Engine: {view.engine}, model <code>{view.model}</code> at <code>{view.endpoint}</code>.</p>
            : <p role="alert">Not configured on the server: {view.problem}</p>}
          <button type="button" onClick={() => void test()} disabled={busy || !view.configured}>Test connection</button>
          <h2>Turn AI {view.enabled ? "off" : "on"}</h2>
          <label>Reason (at least 10 characters, kept in the history)
            <input value={reason} maxLength={300} onChange={e => setReason(e.target.value)} />
          </label>
          <button type="button" onClick={() => void toggle(!view.enabled)} disabled={busy || reason.trim().length < 10}>
            {view.enabled ? "Turn AI off" : "Turn AI on"}
          </button>
          <h2>History</h2>
          {view.history.length === 0 ? <p className="empty">Never switched on. AI is off.</p> : (
            <ul className="plain-list">
              {view.history.map(h => <li key={`${h.changedAt}-${h.changedBy}`}>{new Date(h.changedAt).toLocaleString("en-AU")}: {h.enabled ? "on" : "off"}, {h.reason}</li>)}
            </ul>
          )}
        </section>
      )}
      {note && <p role="status">{note}</p>}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
