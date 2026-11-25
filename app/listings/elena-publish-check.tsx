"use client";
import { useRef, useState } from "react";
import type { ElenaFinding, ElenaReview } from "../../src/domain/listing-validation";
import { JSON_HEADERS } from "./ui";

type Phase = "idle" | "checking" | "result" | "publishing" | "published";
const AREA_LABELS: Record<ElenaFinding["area"], string> = {
  details: "Details", description: "Description", photos: "Photos", siteplan: "Site plan", wording: "Wording", compliance: "Compliance and payment"
};
const MIN_CHECK_MS = 1200; // long enough to read "Elena is checking", short enough not to annoy

/** Moves to the form field a finding is about when it is on this page (focus and scroll); otherwise the link just opens the page. */
function goTo(href: string, e: React.MouseEvent) {
  const hash = href.split("#")[1];
  if (!hash || !href.includes("/edit#")) return;
  // On the edit page the page opens the right step and highlights the field; elsewhere the link opens the edit page at that field.
  if (!document.getElementById("edit-listing-form")) return;
  e.preventDefault();
  window.dispatchEvent(new CustomEvent("listing-focus-field", { detail: hash }));
}

/**
 * Elena as the on-the-spot admin: she checks the listing the way staff would, shows what to fix, and only then offers Publish.
 * The server runs the same review again on the real publish, so this screen can never publish past her.
 * She reads the saved draft, so the owner saves changes first.
 */
export function ElenaPublishCheck({ listingId, onPublished }: { listingId: string; onPublished?: () => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [review, setReview] = useState<ElenaReview | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [error, setError] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);

  async function check() {
    setPhase("checking"); setError(""); setReview(null);
    const started = Date.now();
    try {
      const res = await fetch(`/api/listings/${listingId}/publish?dryRun=1`, { method: "POST", headers: JSON_HEADERS });
      const d = await res.json();
      await new Promise(r => setTimeout(r, Math.max(0, MIN_CHECK_MS - (Date.now() - started))));
      if (res.status === 401) { setError("Sign in to publish this listing."); setPhase("idle"); return; }
      if (!res.ok) { setError(d.error ?? "Elena could not check the listing."); setPhase("idle"); return; }
      setReview(d.elena ?? null);
      setReasons(d.decision?.allowed ? [] : d.decision?.reasons ?? []);
      setPhase("result");
      setTimeout(() => headingRef.current?.focus(), 0);
    } catch {
      setError("Elena could not check the listing."); setPhase("idle");
    }
  }

  async function publish() {
    setPhase("publishing"); setError("");
    try {
      const res = await fetch(`/api/listings/${listingId}/publish`, { method: "POST", headers: JSON_HEADERS });
      const d = await res.json();
      if (d.code === "mfa_required") { window.location.assign(`/mfa?next=${encodeURIComponent(`/listings/${listingId}/edit`)}`); return; }
      if (!res.ok) { setError(d.error ?? "Could not publish."); setPhase("result"); return; }
      if (!d.decision.allowed) { setReview(d.elena ?? null); setReasons(d.decision.reasons); setPhase("result"); return; }
      setPhase("published");
      onPublished?.();
    } catch {
      setError("Could not publish."); setPhase("result");
    }
  }

  const blockers = review?.findings.filter(f => f.severity === "block") ?? [];
  const advice = review?.findings.filter(f => f.severity === "advice") ?? [];
  // Gate reasons the review did not list (it was not wired, or the reason came from somewhere else).
  const extra = reasons.filter(r => !review?.findings.some(f => f.message === r));
  const ready = phase === "result" && blockers.length === 0 && extra.length === 0;

  return (
    <section className="panel elena-check" aria-labelledby="elena-check-title">
      <h2 id="elena-check-title">Publish with Elena</h2>
      <p className="muted">Elena checks your listing the way our admin team would: details, photos, whether the description matches the numbers, wording and compliance. Then it goes live.</p>
      {(phase === "idle" || phase === "result") && <button type="button" className={ready ? "secondary" : ""} onClick={check}>{phase === "idle" ? "Publish" : "Check again"}</button>}
      {phase === "checking" && <p role="status" className="elena-checking"><span className="elena-spinner" aria-hidden="true" />Elena is checking your listing...</p>}
      {phase === "publishing" && <p role="status" className="elena-checking"><span className="elena-spinner" aria-hidden="true" />Publishing...</p>}
      {error && <p role="alert">{error}</p>}
      {phase === "published" && <p role="status"><strong>Published.</strong> Your listing is live. Our team will review it too. <a href={`/listings/${listingId}`}>View listing</a></p>}
      {phase === "result" && (
        <div>
          <h3 ref={headingRef} tabIndex={-1}>{ready ? "Ready to publish" : `Elena found ${blockers.length + extra.length} ${blockers.length + extra.length === 1 ? "thing" : "things"} to fix`}</h3>
          {(blockers.length > 0 || extra.length > 0) && (
            <ul className="elena-findings" aria-label="To fix before publishing">
              {blockers.map(f => <FindingRow key={f.id} f={f} />)}
              {extra.map(r => <li key={r}><span className="badge badge-rejected">Fix</span><span className="elena-msg">{r}</span></li>)}
            </ul>
          )}
          {advice.length > 0 && (
            <>
              <h4>{ready ? "Suggestions (you can still publish)" : "Suggestions"}</h4>
              <ul className="elena-findings" aria-label="Suggestions">{advice.map(f => <FindingRow key={f.id} f={f} />)}</ul>
            </>
          )}
          {ready && <div className="form-bar"><button type="button" onClick={publish}>Publish now</button></div>}
        </div>
      )}
    </section>
  );
}

function FindingRow({ f }: { f: ElenaFinding }) {
  return (
    <li>
      <span className={`badge ${f.severity === "block" ? "badge-rejected" : "sensitive"}`}>{f.severity === "block" ? "Fix" : "Tip"}</span>
      <span className="elena-msg"><span className="muted">{AREA_LABELS[f.area]}. </span>{f.message}</span>
      <a className="elena-fix" href={f.fixHref} onClick={e => goTo(f.fixHref, e)}>Review changes</a>
    </li>
  );
}
