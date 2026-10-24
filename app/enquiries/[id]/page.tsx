"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { JSON_HEADERS } from "../../listings/ui";
import "../../styles/enquiries.css";

type Message = { id: string; senderUserId: string | null; automated: boolean; body: string; sentAt: string };

type OfferLinkState = {
  role: "buyer" | "owner";
  request?: { status: "requested" | "issued" | "declined" };
  link?: { token: string; listingId: string; expiresAt: string };
};

/** One enquiry thread, for its buyer and the listing's owner. Messages cannot be edited or deleted. */
export default function Thread() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<{ enquiry: { listingId: string; buyerUserId: string }; messages: Message[] } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const r = await fetch(`/api/enquiries/${id}/messages`);
      const d = await r.json();
      if (r.ok) setData(d);
      else setLoadError(r.status === 401 ? "Sign in to read this conversation." : r.status === 404 ? "Conversation not found." : d.error ?? "Could not load the conversation.");
    } catch {
      setLoadError("Could not load the conversation.");
    }
  }, [id]);

  const [olr, setOlr] = useState<OfferLinkState | null>(null);
  const loadOlr = useCallback(async () => {
    try {
      const r = await fetch(`/api/enquiries/${id}/offer-link`);
      if (r.ok) setOlr(await r.json());
    } catch { /* the thread still works without this panel */ }
  }, [id]);

  useEffect(() => { void load(); void loadOlr(); }, [load, loadOlr]);

  async function olrAction(action: "request" | "issue" | "decline") {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/enquiries/${id}/offer-link`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action }) });
      if (!r.ok) setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "That did not work.");
      await Promise.all([load(), loadOlr()]);
    } catch {
      setError("That did not work.");
    } finally {
      setBusy(false);
    }
  }

  async function onSend(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/enquiries/${id}/messages`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ body: draft }) });
      const d = await r.json();
      if (r.ok) {
        setDraft("");
        await load();
      } else setError(d.error ?? "Could not send the message.");
    } catch {
      setError("Could not send the message.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <p><a href="/enquiries">Back to messages</a></p>
      <h1>Conversation</h1>
      <p className="muted">Messages are a permanent record and cannot be edited or deleted. Offers made here are not formal offers.</p>
      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && !data && <p className="muted" role="status">Loading…</p>}
      {data && (
        <>
          <ul className="enq-thread">
            {data.messages.map(m => (
              <li key={m.id} className={`enq-msg${m.automated ? " system" : ""}`}>
                {m.body}
                <small>{m.automated ? "Automated notice, " : ""}{new Date(m.sentAt).toLocaleString("en-AU")}</small>
              </li>
            ))}
          </ul>
          <form className="stack" onSubmit={onSend}>
            <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3} maxLength={4000} required aria-label="Reply" />
            <button type="submit" disabled={busy || !draft.trim()}>{busy ? "Sending…" : "Send"}</button>
            {error && <p role="alert">{error}</p>}
          </form>
          {olr && (
            <section aria-label="Formal offer link">
              <h2>Formal offer link</h2>
              {olr.role === "buyer" && olr.link && (
                <p><a href={`/offers/new?listing=${encodeURIComponent(olr.link.listingId)}#token=${encodeURIComponent(olr.link.token)}`}>Make a formal offer</a> (single use, expires {new Date(olr.link.expiresAt).toLocaleString("en-AU")}).</p>
              )}
              {olr.role === "buyer" && olr.request?.status === "requested" && <p className="muted">Waiting for the owner to answer your request.</p>}
              {olr.role === "buyer" && olr.request?.status !== "requested" && !olr.link && (
                <button type="button" disabled={busy} onClick={() => void olrAction("request")}>Request an offer link</button>
              )}
              {olr.role === "owner" && olr.request?.status === "requested" && (
                <p>
                  <button type="button" disabled={busy} onClick={() => void olrAction("issue")}>Approve and issue link</button>{" "}
                  <button type="button" disabled={busy} onClick={() => void olrAction("decline")}>Decline</button>
                </p>
              )}
              {olr.role === "owner" && olr.request?.status !== "requested" && <p className="muted">No open request. You decide every offer yourself; nothing is accepted automatically.</p>}
            </section>
          )}
        </>
      )}
    </main>
  );
}
