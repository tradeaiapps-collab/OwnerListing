"use client";
import { useState } from "react";

interface Refund { id: string; videoId: string; amountCents: number; reason: string; status: "pending" | "succeeded" | "failed"; stripeRefundId: string | null; attempts: number; lastError: string; createdAt: string; refundedAt: string | null }
const aud = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(c / 100);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-AU") : "Not yet");
const pill = (s: Refund["status"]) => (s === "succeeded" ? "good" : s === "failed" ? "bad" : "warn");
const LABEL: Record<Refund["status"], string> = { pending: "Pending", succeeded: "Refunded", failed: "Failed" };

/** Staff-only refund audit trail for a listing's buyer tour videos: when, how much, why, and what Stripe answered. Read only. */
export function VideoRefunds({ listingId }: { listingId: string }) {
  const [rows, setRows] = useState<Refund[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  async function toggle() {
    if (open) return setOpen(false);
    setOpen(true);
    setError("");
    const r = await fetch(`/api/staff/listings/${listingId}/video-refunds`).catch(() => null);
    if (!r || !r.ok) return setError("Could not load video refunds.");
    setRows(((await r.json()) as { refunds: Refund[] }).refunds);
  }

  return (
    <div className="video-refunds">
      <button type="button" className="link-button" aria-expanded={open} onClick={() => void toggle()}>Video refunds</button>
      {open && (
        <div role="region" aria-label="Video refunds" aria-live="polite">
          {error && <p className="error" role="alert">{error}</p>}
          {!error && rows === null && <p className="muted">Loading</p>}
          {rows && rows.length === 0 && <p className="muted">No video refunds for this listing.</p>}
          {rows && rows.length > 0 && (
            <ul className="plain-list">
              {rows.map(r => (
                <li key={r.id}>
                  <span className={`status-pill ${pill(r.status)}`}>{LABEL[r.status]}</span> <strong>{aud(r.amountCents)}</strong>
                  <br /><span className="muted">Requested {when(r.createdAt)}. Refunded {when(r.refundedAt)}.</span>
                  <br /><span className="muted">{r.reason}</span>
                  {r.stripeRefundId && <><br /><span className="muted">Stripe refund {r.stripeRefundId}</span></>}
                  {r.status !== "succeeded" && r.lastError && <><br /><span className="muted">Last error after {r.attempts} attempt{r.attempts === 1 ? "" : "s"}: {r.lastError}</span></>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
