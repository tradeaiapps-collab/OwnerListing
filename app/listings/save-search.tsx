"use client";
import { useState } from "react";
import { parseSearchQuery } from "../../src/domain/listing-search";
import { savedInputFromQuery } from "../../src/domain/saved-search-link";
import { JSON_HEADERS } from "./ui";

/** Saves the applied filters as a buyer's saved search. Alerts stay off until the buyer opts in on the saved searches page. */
export function SaveSearch({ query }: { query: string }) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "signin" | "error">("idle");
  const [msg, setMsg] = useState("");
  const parsed = savedInputFromQuery(parseSearchQuery(new URLSearchParams(query)));

  async function save() {
    if (!parsed.ok) return;
    setState("saving");
    try {
      const r = await fetch("/api/buyer/saved-searches", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(parsed.value) });
      if (r.status === 401) { setState("signin"); return; }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setState("error"); setMsg(d.error ?? "Could not save the search."); return; }
      setState("saved");
      setMsg(parsed.dropped.length > 0 ? `Saved. ${parsed.dropped.join(" and ")} can't be saved, because alerts match on property facts only.` : "Saved.");
    } catch { setState("error"); setMsg("Could not save the search."); }
  }

  return (
    <div className="save-search">
      <button type="button" className="secondary" disabled={!parsed.ok || state === "saving"} onClick={save}>Save this search</button>
      {!parsed.ok && <small className="muted">{parsed.message}</small>}
      {state === "saved" && <small role="status">{msg} <a href="/buyer/saved-searches">Manage alerts</a></small>}
      {state === "signin" && <small role="alert"><a href={`/login?as=buyer&next=${encodeURIComponent(`/listings?${query}`)}`}>Sign in as a buyer</a> to save a search.</small>}
      {state === "error" && <small role="alert">{msg}</small>}
    </div>
  );
}
