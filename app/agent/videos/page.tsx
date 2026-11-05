"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import "../../styles/agent-workspace.css";
import "../../styles/listing-video.css";

type Video = { id: string; status: "queued" | "processing" | "ready" | "failed"; visibility: "private" | "public"; requestedAt: string; generatedAt: string | null; error: string; attempts: number };
type Row = { listingId: string; title: string; suburb: string; status: string; photoCount: number; video: Video | null };
type Budget = { teamId: string; monthlyBudgetCents: number; spentCents: number; remainingCents: number };
type Overview = { rows: Row[]; budget: Budget | null; role: string | null; teamId: string | null; costCents: number; suggestion: string | null };

const aud = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(c / 100);
const LABEL: Record<Video["status"], string> = { queued: "Waiting to start", processing: "Making your video", ready: "Ready", failed: "Failed" };
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Agent tour videos: generate (charged to the team budget), preview, publish, delete or replace. */
export default function AgentVideos() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const [budgetInput, setBudgetInput] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/videos");
      const b = await r.json().catch(() => ({}));
      if (r.status === 401) return setError("Sign in to manage videos.");
      if (!r.ok) return setError(b.error ?? "Could not load your videos.");
      setData(b as Overview); setError("");
    } catch { setError("Could not load your videos."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // While any video is being made, check again every 15 seconds.
  const working = data?.rows.some(r => r.video && (r.video.status === "queued" || r.video.status === "processing"));
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [working, load]);

  async function act(key: string, url: string, init: RequestInit, done: string) {
    setBusy(key); setNotice(""); setError("");
    try {
      const r = await fetch(url, init);
      const b = await r.json().catch(() => ({}));
      if (!r.ok) setError(b.error ?? "That did not work. Try again."); else { setNotice(done); setPreview(null); await load(); }
    } catch { setError("That did not work. Try again."); } finally { setBusy(""); }
  }
  async function showPreview(id: string) {
    const r = await fetch(`/api/videos/${id}`).catch(() => null);
    const b = r?.ok ? await r.json().catch(() => null) : null;
    if (b?.video?.playbackUrl) setPreview({ id, url: b.video.playbackUrl }); else setError("Could not open the preview.");
  }
  function saveBudget(e: FormEvent) {
    e.preventDefault();
    const dollars = Number(budgetInput);
    if (!data?.teamId || !Number.isFinite(dollars) || dollars < 0) return setError("Enter the monthly budget in dollars.");
    void act("budget", `/api/teams/${data.teamId}/video-budget`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ monthlyBudgetCents: Math.round(dollars * 100) }) }, "Budget saved.");
  }

  const b = data?.budget;
  const pct = b && b.monthlyBudgetCents > 0 ? Math.min(100, Math.round((b.spentCents / b.monthlyBudgetCents) * 100)) : 0;
  return (
    <main className="lv" aria-labelledby="lv-h">
      <div>
        <h1 id="lv-h">Tour videos</h1>
        <p className="lv-meta"><a href="/agent/workspace">Workspace</a> · <a href="/agent/listings">Appointed listings</a></p>
      </div>
      {error && <p className="lv-error" role="alert">{error}</p>}
      {notice && <p className="lv-ok" role="status">{notice}</p>}
      {data?.suggestion && (
        <div className="lv-elena">
          <img src="/assistant/elena-pose-tablet.jpg" alt="" width={48} height={48} />
          <p><strong>Elena:</strong> {data.suggestion}</p>
        </div>
      )}
      {data && (
        <section className="aw-card lv-budget" aria-labelledby="lv-budget-h">
          <h2 id="lv-budget-h" style={{ margin: 0 }}>Team video budget</h2>
          {!data.teamId ? (
            <p className="lv-meta">Join or create an <a href="/agent/team">agency team</a> to pay for videos from a team budget.</p>
          ) : (
            <>
              <p className="lv-meta">{aud(b?.spentCents ?? 0)} of {aud(b?.monthlyBudgetCents ?? 0)} used this month. Each video costs {aud(data.costCents)}, refunded if it fails.</p>
              <div className="lv-bar" role="img" aria-label={`${pct}% of the monthly video budget used`}><span style={{ width: `${pct}%` }} /></div>
              {data.role === "manager" ? (
                <form className="lv-form" onSubmit={saveBudget}>
                  <label>Monthly budget (AUD)<input type="number" inputMode="decimal" min="0" step="1" value={budgetInput} onChange={e => setBudgetInput(e.target.value)} placeholder={String((b?.monthlyBudgetCents ?? 0) / 100)} /></label>
                  <button type="submit" disabled={busy === "budget"}>Save budget</button>
                </form>
              ) : <p className="lv-meta">A team manager sets the budget.</p>}
            </>
          )}
        </section>
      )}
      {data && data.rows.length === 0 && <p className="lv-meta">You have no appointed listings yet. Videos are made for listings an owner has appointed you to.</p>}
      <ul className="lv-list">
        {data?.rows.map(r => {
          const v = r.video;
          const canMake = !v || v.status === "failed";
          return (
            <li key={r.listingId} className="lv-row">
              <div>
                <div className="lv-head">
                  <span className="lv-title">{r.title}</span>
                  {v ? <span className={`lv-status${v.status === "failed" ? " failed" : ""}`}>{LABEL[v.status]}{v.status === "ready" && v.visibility === "public" ? ", published" : ""}</span> : <span className="lv-status">No video</span>}
                </div>
                <p className="lv-meta">{r.suburb ? `${r.suburb} · ` : ""}{r.photoCount} photo{r.photoCount === 1 ? "" : "s"}{r.photoCount < 2 ? " (add at least 2 to make a video)" : ""}</p>
                {v?.status === "failed" && <p className="lv-error">{v.error || "Hedra could not make this video."} The cost was refunded.</p>}
                {v && (v.status === "queued" || v.status === "processing") && <p className="lv-meta" role="status">This usually takes 5 to 10 minutes. You can leave this page.</p>}
              </div>
              <div className="lv-actions">
                {canMake && <button type="button" className="primary" disabled={!!busy || r.photoCount < 2 || !data.teamId} onClick={() => act(r.listingId, "/api/videos/generate", post({ listingId: r.listingId }), "Video queued.")}>{v ? "Try again" : "Generate video"} ({aud(data.costCents)})</button>}
                {v?.status === "ready" && <button type="button" onClick={() => showPreview(v.id)}>Preview</button>}
                {v?.status === "ready" && v.visibility === "private" && <button type="button" className="primary" disabled={!!busy} onClick={() => act(v.id, `/api/videos/${v.id}/publish`, { method: "POST" }, "Video published on the listing.")}>Publish</button>}
                {v?.status === "ready" && <button type="button" disabled={!!busy} onClick={() => act(v.id, `/api/videos/${v.id}`, { method: "DELETE" }, "Video removed. You can generate a new one.")}>Delete or replace</button>}
              </div>
              {preview && v && preview.id === v.id && (
                <div className="lv-player-wrap">
                  <video className="lv-player" src={preview.url} controls playsInline preload="metadata" aria-label={`Preview of the video for ${r.title}`} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
