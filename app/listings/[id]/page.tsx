"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { JSON_HEADERS, fieldStyle } from "../ui";

interface Listing { id: string; title: string; address: string; jurisdiction: string; transactionType: string; useClass: string; propertyType: string }

export default function ListingDetail() {
  const { id } = useParams<{ id: string }>();
  const [listing, setListing] = useState<Listing | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/listings/${id}`).then(async r => {
      if (!r.ok) return setNotFound(true);
      setListing((await r.json()).listing);
    }).catch(() => setNotFound(true));
  }, [id]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote("");
    try {
      const res = await fetch(`/api/listings/${id}/enquiries`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ body: text }) });
      if (res.status === 401) setSignedOut(true);
      else if (!res.ok) setNote((await res.json()).error ?? "Could not send.");
      else { setText(""); setNote("Sent. Replies appear under Messages."); }
    } catch {
      setNote("Could not send.");
    } finally {
      setBusy(false);
    }
  }

  if (notFound) return <main><p>Listing not found.</p><p><a href="/listings">Back to listings</a></p></main>;
  if (!listing) return <main><p>Loading...</p></main>;
  return (
    <main style={{ overflowWrap: "anywhere" }}>
      <h1>{listing.title}</h1>
      <p>{listing.address}</p>
      <p><small>{listing.jurisdiction} · {listing.transactionType === "sale" ? "Sale" : "Rent"} · {listing.useClass} · {listing.propertyType}</small></p>
      <h2>Message the owner</h2>
      <form onSubmit={send} style={{ display: "grid", gap: 8 }}>
        <textarea value={text} onChange={e => setText(e.target.value)} maxLength={4000} rows={5} required style={fieldStyle} aria-label="Your message" />
        <button type="submit" disabled={busy || !text.trim()} style={fieldStyle}>Send</button>
      </form>
      {signedOut && <p role="alert"><a href="/api/auth/google/start">Sign in with Google</a> to contact the owner.</p>}
      {note && <p role="status">{note}</p>}
      <p><a href="/enquiries">Messages</a> · <a href="/listings">All listings</a></p>
    </main>
  );
}
