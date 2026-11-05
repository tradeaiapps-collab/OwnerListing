"use client";
import { useEffect, useState } from "react";
import { TEMPLATE_CATEGORY_LABELS, type TemplateView } from "../../src/domain/listing-template";

/** "Start from a template" dropdown. Picking one hands the template to onApply; the person still edits everything before saving. Hidden when there are no templates. */
export function TemplatePicker({ onApply }: { onApply: (t: TemplateView) => void }) {
  const [templates, setTemplates] = useState<TemplateView[]>([]);
  const [picked, setPicked] = useState("");
  useEffect(() => {
    fetch("/api/templates").then(async r => setTemplates(r.ok ? ((await r.json()) as { templates?: TemplateView[] }).templates ?? [] : [])).catch(() => setTemplates([]));
  }, []);
  if (templates.length === 0) return null;
  return (
    <div className="panel stack">
      <label className="field">Start from a template
        <select value={picked} onChange={e => { setPicked(e.target.value); const t = templates.find(x => x.id === e.target.value); if (t) onApply(t); }}>
          <option value="">Select template</option>
          {templates.map(t => <option key={t.id} value={t.id}>{t.name} ({TEMPLATE_CATEGORY_LABELS[t.category]}{t.scope === "team" ? ", team" : ""})</option>)}
        </select>
      </label>
      <small className="muted">Fills the description and standard fields. Add the price, photos and anything unique to this property, then save.</small>
      {picked && <small role="status" className="muted">Template applied. <a href="/agent/templates">Manage templates</a></small>}
    </div>
  );
}
