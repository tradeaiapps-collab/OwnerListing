"use client";
import { useState, type FormEvent } from "react";
import { AMENITIES, AMENITY_LABELS } from "../../src/domain/listing-details";
import { FURNISHINGS, TEMPLATE_CATEGORIES, TEMPLATE_CATEGORY_LABELS, type TemplateContent, type TemplateView } from "../../src/domain/listing-template";
import { JSON_HEADERS } from "./ui";

export type TeamOption = { teamId: string; teamName: string; canManage: boolean };
const num = (v: FormDataEntryValue | null) => { const s = String(v ?? "").trim(); return s === "" ? null : Number(s); };

/** Create or edit a template: name, category, a short note and the standard fields. Price, photos, title and address are never part of a template. */
export function TemplateForm({ initial, teams, onSaved, onCancel }: { initial?: TemplateView | undefined; teams: TeamOption[]; onSaved: () => void; onCancel: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const c: TemplateContent = initial?.content ?? {};
  const manageable = teams.filter(t => t.canManage);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const content = {
      description: String(fd.get("description") ?? "").trim() || null, propertyType: fd.get("propertyType") || null, transactionType: fd.get("transactionType") || null,
      bedrooms: num(fd.get("bedrooms")), bathrooms: num(fd.get("bathrooms")), parking: num(fd.get("parking")),
      amenities: fd.getAll("amenities").map(String)
    };
    const body: Record<string, unknown> = { name: fd.get("name"), category: fd.get("category"), furnishing: fd.get("furnishing") || null, note: fd.get("note") || null, content };
    if (!initial && fd.get("teamId")) body["teamId"] = fd.get("teamId");
    setBusy(true); setError("");
    try {
      const res = await fetch(initial ? `/api/templates/${initial.id}` : "/api/templates", { method: initial ? "PATCH" : "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) onSaved(); else setError(d.error ?? "Could not save the template.");
    } catch { setError("Could not save the template."); } finally { setBusy(false); }
  }

  return (
    <form className="stack panel" onSubmit={submit}>
      <h2>{initial ? "Edit template" : "New template"}</h2>
      <div className="form-grid">
        <label className="field">Template name
          <input name="name" required minLength={2} maxLength={80} defaultValue={initial?.name ?? ""} placeholder="e.g. 3-bed family house" />
        </label>
        <label className="field">Category
          <select name="category" defaultValue={initial?.category ?? "house"}>
            {TEMPLATE_CATEGORIES.map(k => <option key={k} value={k}>{TEMPLATE_CATEGORY_LABELS[k]}</option>)}
          </select>
        </label>
        <label className="field">Furnishing
          <select name="furnishing" defaultValue={initial?.furnishing ?? ""}>
            <option value="">Not set</option>
            {FURNISHINGS.map(f => <option key={f} value={f}>{f === "furnished" ? "Furnished" : "Unfurnished"}</option>)}
          </select>
        </label>
        {!initial && manageable.length > 0 && (
          <label className="field">Who can use it
            <select name="teamId" defaultValue="">
              <option value="">Only me</option>
              {manageable.map(t => <option key={t.teamId} value={t.teamId}>Everyone in {t.teamName}</option>)}
            </select>
          </label>
        )}
      </div>
      <label className="field">Note for yourself (optional)
        <input name="note" maxLength={300} defaultValue={initial?.note ?? ""} />
      </label>
      <div className="form-grid">
        <label className="field">Sale or rent
          <select name="transactionType" defaultValue={c.transactionType ?? ""}><option value="">Not set</option><option value="sale">Sale</option><option value="rent">Rental</option></select>
        </label>
        <label className="field">Property type
          <select name="propertyType" defaultValue={c.propertyType ?? ""}>
            <option value="">Not set</option>
            {["house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"].map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
          </select>
        </label>
      </div>
      <label className="field">Description
        <textarea name="description" rows={6} maxLength={5000} defaultValue={c.description ?? ""} />
      </label>
      <div className="form-grid cols-3">
        {(["bedrooms", "bathrooms", "parking"] as const).map(k => (
          <label key={k} className="field">{k === "parking" ? "Parking spaces" : k.charAt(0).toUpperCase() + k.slice(1)}
            <input name={k} type="number" inputMode="numeric" min={0} max={20} step={1} defaultValue={c[k] ?? ""} />
          </label>
        ))}
      </div>
      <fieldset className="mf-group">
        <legend>Extras</legend>
        <div className="amenity-checks">
          {AMENITIES.map(a => <label key={a} className="check"><input type="checkbox" name="amenities" value={a} defaultChecked={c.amenities?.includes(a) ?? false} /><span>{AMENITY_LABELS[a]}</span></label>)}
        </div>
      </fieldset>
      <small className="muted">Templates keep the description and standard fields only. Price, photos, title and address are added on each listing.</small>
      {error && <p role="alert">{error}</p>}
      <div className="form-bar">
        <button type="submit" disabled={busy}>{busy ? "Saving..." : "Save template"}</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
