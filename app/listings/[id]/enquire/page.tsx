"use client";
import { useEffect, useState } from "react";
import { personaById } from "../../../../src/domain/assistant-persona";
import { useParams } from "next/navigation";
import { CopilotPanel } from "../../../enquiries/copilot-panel";
import { JSON_HEADERS } from "../../ui";
import "../../../styles/enquiries.css";
import "../../../styles/chat-copilot.css";

/** Buyer screen: message the owner of a published listing. You write on the left, Elena helps on the right. The server checks verification, limits and the listing. */
export default function Enquire() {
  const { id } = useParams<{ id: string }>();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const persona = personaById(undefined);
  const [tab, setTab] = useState<"chat" | "elena">("chat");

  useEffect(() => {
    document.body.classList.add("el-chat-page");
    return () => document.body.classList.remove("el-chat-page");
  }, []);

  async function send(body: string) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/listings/${id}/enquiries`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ body }) });
      const d = await r.json();
      if (r.ok) window.location.assign(`/enquiries/${d.enquiry.id}`);
      else setError(r.status === 401 ? "Sign in to contact the owner." : d.error ?? "Could not send your message.");
    } catch {
      setError("Could not send your message.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="cx-page">
      <p className="cx-back"><a href={`/listings/${id}`}>Back to the listing</a></p>
      <header className="cx-head">
        <div>
          <h1>Contact the owner</h1>
          <p className="muted">You need a verified email, mobile and ID check. Messages are a permanent record and cannot be edited or deleted. Offers made in messages are not formal offers.</p>
        </div>
      </header>
      <div className="cx-tabs" role="tablist" aria-label="Write or get help">
        <button type="button" role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>Write</button>
        <button type="button" role="tab" aria-selected={tab === "elena"} onClick={() => setTab("elena")}>{persona.name}</button>
      </div>
      <div className="cx-grid" data-tab={tab}>
        <form className="cx-chat" onSubmit={e => { e.preventDefault(); void send(text); }}>
          <label htmlFor="cx-first">Your message to the owner</label>
          <textarea id="cx-first" value={text} onChange={e => setText(e.target.value)} rows={8} maxLength={4000} required placeholder="Write it yourself, or tell Elena what you want to say." />
          <div className="cx-row">
            <small className="muted">{text.length}/4000</small>
            <button type="submit" className="cx-btn" disabled={busy || !text.trim()}>{busy ? "Sending…" : "Send message"}</button>
          </div>
          {error && <p role="alert" className="cx-error">{error}</p>}
        </form>
        <CopilotPanel persona={{ name: persona.name, portrait: persona.portrait }} refreshKey={0} onUse={t => { setText(t); setTab("chat"); }} onSend={send} busy={busy} />
      </div>
    </main>
  );
}
