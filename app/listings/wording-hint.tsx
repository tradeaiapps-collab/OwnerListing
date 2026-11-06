"use client";
import { useEffect, useState } from "react";
import { PROFANITY_MESSAGE, findProfanity } from "../../src/domain/profanity-filter";
import { JSON_HEADERS } from "./ui";

export interface WordingFlagView { match: string; severity: "block" | "warn"; message: string; suggestion: string }

/** The flags as a list: what was found, why, and a neutral way to say it. Blocks and warnings look different. */
export function WordingFlagList({ flags, field }: { flags: readonly WordingFlagView[]; field?: string }) {
  if (flags.length === 0) return null;
  const blocking = flags.some(f => f.severity === "block");
  return (
    <div className={`wording-flags${blocking ? " is-block" : ""}`} role={blocking ? "alert" : "status"}>
      <p><strong>{blocking ? "This wording can't be published" : "Check this wording"}{field ? ` (${field})` : ""}</strong></p>
      <ul className="plain-list">
        {flags.map(f => (
          <li key={`${f.match}-${f.severity}`}>
            <span className={`badge ${f.severity === "block" ? "badge-rejected" : "sensitive"}`}>{f.severity === "block" ? "Blocked" : "Advice"}</span>{" "}
            <q>{f.match}</q>. {f.message} <span className="muted">{f.suggestion}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Checks text against the anti-discrimination filter while the owner types (debounced). Advice only on screen; the publish gate
 * and the message send are where the rule is enforced.
 */
export function WordingHint({ text, field }: { text: string; field?: string }) {
  const [flags, setFlags] = useState<WordingFlagView[]>([]);
  useEffect(() => {
    if (!text.trim()) { setFlags([]); return; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch("/api/listings/wording-check", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ text }), signal: ctrl.signal })
        .then(r => (r.ok ? r.json() : { flags: [] }))
        .then((d: { flags?: WordingFlagView[] }) => setFlags(d.flags ?? []))
        .catch(() => undefined);
    }, 400);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [text]);
  const [allow, setAllow] = useState(false);
  const rude = findProfanity(text);
  return (
    <>
      <WordingFlagList flags={flags} {...(field ? { field } : {})} />
      {rude.length > 0 && (
        <div className="wording-flags is-block" role="alert">
          <p><strong>{PROFANITY_MESSAGE}{field ? ` (${field})` : ""}</strong></p>
          <label className="check"><input type="checkbox" name="allowFlagged" value={field ?? "text"} checked={allow} onChange={e => setAllow(e.target.checked)} /> Post anyway (for example a product or street name)</label>
        </div>
      )}
    </>
  );
}
