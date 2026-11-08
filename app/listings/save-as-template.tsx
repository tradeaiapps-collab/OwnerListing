"use client";
import { useEffect, useState, type FormEvent } from "react";
import { TEMPLATE_CATEGORIES, TEMPLATE_CATEGORY_LABELS } from "../../src/domain/listing-template";
import { JSON_HEADERS } from "./ui";

/** Owner or appointed agent saves this listing's description and standard fields as a template. Price, photos, title and address are not copied. */
export function SaveAsTemplate({ listingId, defaultName, userType }: { listingId: string; defaultName: string; userType: string | null }) {
  const [mine, setMine] = useState(false);
  const [open, setOpen] = useState(false);
  // Shown only on the viewer's own listings (owner) or appointed listings (agent); the server checks again on save.
  useEffect(() => {
    if (userType !== "owner" && userType !== "agent") return;
    fetch(userType === "owner" ? "/api/listings/mine" : "/api/agent/listings")
      .then(async r => { const d = (await r.json().catch(() => ({}))) as { listings?: { id?: string; listingId?: string }[] }; setMine(r.ok && (d.listings ?? []).some(l => (l.id ?? l.listingId) === listingId)); })
      .catch(() => setMine(false));
  }, [userType, listingId]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/templates", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ fromListingId: listingId, name: fd.get("name"), category: fd.get("category"), furnishing: fd.get("furnishing") || null, note: fd.get("note") || null }) });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) { setMsg({ ok: true, text: "Template saved." }); setOpen(false); } else setMsg({ ok: false, text: d.error ?? "Could not save the template." });
    } catch { setMsg({ ok: false, text: "Could not save the template." }); } finally { setBusy(false); }
  }
  if (!mine) return null;
  return (
    <div className="stack">
      <button type="button" className="button secondary" aria-expanded={open} onClick={() => setOpen(!open)}>Save as template</button>
      {open && (
        <form className="stack panel" onSubmit={submit}>
          <label className="field">Template name<input name="name" required minLength={2} maxLength={80} defaultValue={defaultName.slice(0, 80)} /></label>
          <div className="form-grid">
            <label className="field">Category
              <select name="category" defaultValue="house">{TEMPLATE_CATEGORIES.map(k => <option key={k} value={k}>{TEMPLATE_CATEGORY_LABELS[k]}</option>)}</select>
            </label>
            <label className="field">Furnishing
              <select name="furnishing" defaultValue=""><option value="">Not set</option><option value="furnished">Furnished</option><option value="unfurnished">Unfurnished</option></select>
            </label>
          </div>
          <label className="field">Note (optional)<input name="note" maxLength={300} /></label>
          <small className="muted">Saves the description and standard fields. Photos, price, title and address are not copied.</small>
          <div className="form-bar"><button type="submit" disabled={busy}>{busy ? "Saving..." : "Save template"}</button></div>
        </form>
      )}
      {msg && <p role={msg.ok ? "status" : "alert"}>{msg.text} {msg.ok && <a href="/agent/templates">View templates</a>}</p>}
    </div>
  );
}
