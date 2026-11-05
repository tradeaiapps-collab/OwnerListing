"use client";
import { useCallback, useEffect, useState } from "react";
import { AMENITY_LABELS } from "../../../src/domain/listing-details";
import { FURNISHINGS, TEMPLATE_CATEGORIES, TEMPLATE_CATEGORY_LABELS, type TemplateView } from "../../../src/domain/listing-template";
import { JSON_HEADERS } from "../../listings/ui";
import { TemplateForm, type TeamOption } from "../../listings/template-form";
import "../../styles/enquiries.css";

type Loaded = { templates: TemplateView[]; teams: TeamOption[] };

/** Listing templates: own and team templates, filtered by category. Preview, edit, share with the team and delete. */
export default function Templates() {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [category, setCategory] = useState("");
  const [furnishing, setFurnishing] = useState("");
  const [editing, setEditing] = useState<TemplateView | "new" | null>(null);
  const [preview, setPreview] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams(); if (category) q.set("category", category); if (furnishing) q.set("furnishing", furnishing);
      const r = await fetch(`/api/templates?${q}`);
      if (r.status === 401) return setError("Sign in to use your templates.");
      const body = (await r.json().catch(() => ({}))) as Partial<Loaded> & { error?: string };
      if (!r.ok) return setError(body.error ?? "Could not load your templates.");
      setData({ templates: body.templates ?? [], teams: body.teams ?? [] }); setError("");
    } catch { setError("Could not load your templates."); }
  }, [category, furnishing]);
  useEffect(() => { void load(); }, [load]);

  async function act(id: string, init: RequestInit) {
    setError("");
    try {
      const r = await fetch(`/api/templates/${id}`, init);
      if (!r.ok) setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "That did not work.");
    } catch { setError("That did not work."); }
    setConfirmDelete(""); await load();
  }
  const teamName = (id?: string) => data?.teams.find(t => t.teamId === id)?.teamName ?? "your team";
  const manageable = data?.teams.find(t => t.canManage);

  function Row({ t }: { t: TemplateView }) {
    const c = t.content;
    return (
      <li className="panel stack">
        <div>
          <strong>{t.name}</strong> <small className="muted">{TEMPLATE_CATEGORY_LABELS[t.category]}{t.furnishing ? `, ${t.furnishing}` : ""}{t.scope === "team" ? `, shared with ${teamName(t.teamId)}` : ""}</small>
          {t.note && <p className="muted">{t.note}</p>}
        </div>
        {preview === t.id && (
          <div>
            {c.description ? <p>{c.description}</p> : <p className="muted">No description.</p>}
            <p className="muted">{[c.bedrooms != null && `${c.bedrooms} bed`, c.bathrooms != null && `${c.bathrooms} bath`, c.parking != null && `${c.parking} parking`, c.propertyType, c.transactionType].filter(Boolean).join(" · ") || "No standard fields set."}</p>
            {c.amenities && c.amenities.length > 0 && <p className="muted">{c.amenities.map(a => AMENITY_LABELS[a]).join(", ")}</p>}
          </div>
        )}
        <div className="form-bar">
          <button type="button" className="secondary" aria-expanded={preview === t.id} onClick={() => setPreview(preview === t.id ? "" : t.id)}>{preview === t.id ? "Hide preview" : "Preview"}</button>
          {t.canEdit && <button type="button" className="secondary" onClick={() => setEditing(t)}>Edit</button>}
          {t.canEdit && t.scope === "personal" && manageable && <button type="button" className="secondary" onClick={() => act(t.id, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ teamId: manageable.teamId }) })}>Share with {manageable.teamName}</button>}
          {t.canEdit && t.scope === "team" && <button type="button" className="secondary" onClick={() => act(t.id, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ teamId: null }) })}>Stop sharing</button>}
          {t.canEdit && (confirmDelete === t.id
            ? <button type="button" onClick={() => act(t.id, { method: "DELETE" })}>Confirm delete</button>
            : <button type="button" className="secondary" onClick={() => setConfirmDelete(t.id)}>Delete</button>)}
          {!t.canEdit && <small className="muted">Read-only: only a principal or manager can change team templates.</small>}
        </div>
      </li>
    );
  }

  const mine = data?.templates.filter(t => t.scope === "personal") ?? [], team = data?.templates.filter(t => t.scope === "team") ?? [];
  return (
    <main>
      <h1>Listing templates</h1>
      <p className="muted">Save a description and standard fields once, then start new listings from them. Price, photos, title and address are added each time.</p>
      {editing ? (
        <TemplateForm key={editing === "new" ? "new" : editing.id} initial={editing === "new" ? undefined : editing} teams={data?.teams ?? []} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />
      ) : (
        <div className="form-bar">
          <button type="button" onClick={() => setEditing("new")}>New template</button>
          <label className="field">Category
            <select value={category} onChange={e => setCategory(e.target.value)}><option value="">All</option>{TEMPLATE_CATEGORIES.map(k => <option key={k} value={k}>{TEMPLATE_CATEGORY_LABELS[k]}</option>)}</select>
          </label>
          <label className="field">Furnishing
            <select value={furnishing} onChange={e => setFurnishing(e.target.value)}><option value="">All</option>{FURNISHINGS.map(f => <option key={f} value={f}>{f === "furnished" ? "Furnished" : "Unfurnished"}</option>)}</select>
          </label>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p className="muted" role="status">Loading...</p>}
      {data && data.templates.length === 0 && <p className="empty">{category || furnishing ? "No templates match these filters." : "No templates yet. Create one, or open a listing and choose Save as template."}</p>}
      {mine.length > 0 && <><h2>My templates</h2><ul className="card-list">{mine.map(t => <Row key={t.id} t={t} />)}</ul></>}
      {team.length > 0 && <><h2>Team templates</h2><ul className="card-list">{team.map(t => <Row key={t.id} t={t} />)}</ul></>}
      <p><a className="button secondary" href="/listings/new">Create a listing</a></p>
    </main>
  );
}
