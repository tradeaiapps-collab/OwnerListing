"use client";
import { useState } from "react";

/**
 * "Did Elena's suggestion work?" Optional, one tap. Sends yes, partly or no (and a 1-5 rating when given) to /api/elena/feedback, which
 * records it against the suggestion. Used after a suggestion is acted on (negotiation, settlement, dispute).
 */
export function ElenaFeedback({ suggestionId, overall, question = "Did Elena's suggestion work?" }: { suggestionId?: string; overall?: { kind: "settlement" | "dispute"; subjectId: string }; question?: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  async function send(helpful: "yes" | "partial" | "no") {
    setState("busy");
    // "overall" asks about the whole settlement or dispute: the server finds or creates the record for it, for the signed-in person.
    const r = overall
      ? await fetch("/api/elena/feedback/overall", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...overall, helpful }) }).catch(() => null)
      : await fetch("/api/elena/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ suggestionId, helpful }) }).catch(() => null);
    setState(r?.ok ? "done" : "error");
  }
  if (state === "done") return <p className="muted" role="status">Thanks, Elena will learn from that.</p>;
  return (
    <div role="group" aria-label={question} className="filters">
      <span>{question}</span>
      <button type="button" className="secondary" disabled={state === "busy"} onClick={() => void send("yes")}>Yes</button>
      <button type="button" className="secondary" disabled={state === "busy"} onClick={() => void send("partial")}>Partly</button>
      <button type="button" className="secondary" disabled={state === "busy"} onClick={() => void send("no")}>No</button>
      {state === "error" && <span role="alert">Could not save that. Try again.</span>}
    </div>
  );
}
