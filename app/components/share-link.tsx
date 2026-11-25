"use client";
import { useState } from "react";
import { listingShareUrl } from "../../src/domain/share-link";

/** Copy link and Share (phone share sheet where available) for a published listing. Drafts get a hint instead. */
export function ShareLink({ listingId, published, title }: { listingId?: string; published: boolean; title?: string }) {
  const [note, setNote] = useState("");
  if (!published || !listingId) {
    return <p className="muted share-hint">Publish your listing first, then copy or share its link here.</p>;
  }
  const url = () => listingShareUrl(window.location.origin, listingId);
  const copy = async () => {
    try { await navigator.clipboard.writeText(url()); setNote("Link copied"); }
    catch { setNote(`Copy failed. Select and copy: ${url()}`); }
  };
  const share = async () => {
    if (typeof navigator.share !== "function") { await copy(); return; }
    try { await navigator.share({ url: url(), ...(title ? { title } : {}) }); }
    catch (e) { if (!(e instanceof DOMException && e.name === "AbortError")) await copy(); }
  };
  return (
    <div className="share-link">
      <button type="button" className="secondary" onClick={() => void copy()} aria-label="Copy listing link">Copy link</button>
      <button type="button" className="secondary" onClick={() => void share()} aria-label="Share listing">Share</button>
      <span role="status" className="muted share-note">{note}</span>
    </div>
  );
}
