"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { formatPrice } from "../../../src/domain/listing-details";
import "../../styles/documents.css";
import { actionHref, publicPhotos } from "../../../src/domain/listing-actions";
import { JSON_HEADERS } from "../ui";
import "../../styles/cards.css";
import "../../styles/detail.css";

interface Listing {
  id: string;
  title: string;
  address: string;
  jurisdiction: string;
  transactionType: string;
  useClass: string;
  propertyType: string;
  suburb?: string;
  postcode?: string;
  priceCents?: number;
  bedrooms?: number;
  bathrooms?: number;
  parking?: number;
  status: string;
  disclosures: { key: string; satisfied: boolean }[];
  updatedAt: string;
}

type PublicDoc = { id: string; kind: string; visibility: string; status: string };

/** Public photos, floor plans and videos of a published listing. Renders nothing when there are none or they cannot be loaded. */
function Gallery({ listingId, title }: { listingId: string; title: string }) {
  const [docs, setDocs] = useState<PublicDoc[]>([]);
  useEffect(() => {
    setDocs([]);
    fetch(`/api/listings/${listingId}/documents`)
      .then(async r => (r.ok ? (await r.json()).documents as PublicDoc[] : []))
      .then(all => setDocs(all.filter(d => d.visibility === "public" && d.status === "active")))
      .catch(() => setDocs([]));
  }, [listingId]);
  const images = publicPhotos(docs);
  const links = [...docs.filter(d => d.kind === "floorplan").map(d => ({ d, label: "Floor plan" })), ...docs.filter(d => d.kind === "video" || d.kind === "video_360").map(d => ({ d, label: d.kind === "video" ? "Video" : "360 video" }))];
  return (
    <section aria-label="Photos and plans">
      {images.length === 0 && <div className="detail-media" role="img" aria-label="No photos added yet"><span>No photos yet</span></div>}
      {images.length > 0 && (
        <ul className="gallery">
          {images.map((d, i) => (
            <li key={d.id}>
              <img src={`/api/documents/${d.id}/file`} loading="lazy" alt={`${d.kind === "photo" ? "Photo" : "360 degree photo"} ${i + 1} of ${images.length}: ${title}`} />
            </li>
          ))}
        </ul>
      )}
      {links.length > 0 && (
        <ul className="gallery-links">
          {links.map(({ d, label }, i) => <li key={d.id}><a href={`/api/documents/${d.id}/file`}>{label} {i + 1} (download)</a></li>)}
        </ul>
      )}
    </section>
  );
}

/** Bookmarks the listing for a signed-in buyer (no search is created). Signed-out visitors sign in and return here; owners and agents see no Save button. */
function SaveButton({ listingId, userType }: { listingId: string; userType: string | null }) {
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const buyer = userType === "buyer";
  useEffect(() => {
    if (!buyer) return;
    fetch("/api/buyer/saved-listings")
      .then(async r => (r.ok ? (await r.json()).listings as { listingId: string }[] : []))
      .then(all => setSaved(all.some(l => l.listingId === listingId)))
      .catch(() => setSaved(false));
  }, [buyer, listingId]);
  if (userType === null) return <a className="button secondary" href={actionHref(listingId, "save", false)}>Save</a>;
  if (!buyer) return null;
  async function toggle() {
    setBusy(true);
    setError("");
    try {
      const res = saved
        ? await fetch(`/api/buyer/saved-listings/${listingId}`, { method: "DELETE" })
        : await fetch("/api/buyer/saved-listings", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ listingId }) });
      if (res.ok) setSaved(!saved);
      else setError("Could not update your saved homes.");
    } catch {
      setError("Could not update your saved homes.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" className="button secondary" onClick={toggle} disabled={busy} aria-pressed={saved}>{saved ? "Saved" : "Save"}</button>
      {error && <span role="alert">{error}</span>}
    </>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

export default function ListingDetail() {
  const { id } = useParams<{ id: string }>();
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [userType, setUserType] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/me").then(async r => setUserType(r.ok ? (await r.json()).user?.userType ?? null : null)).catch(() => setUserType(null));
  }, []);

  useEffect(() => {
    setListing(null);
    setError("");
    fetch(`/api/listings/${id}`)
      .then(async r => {
        const d = await r.json();
        if (r.ok) setListing(d.listing);
        else setError(r.status === 404 ? "This listing was not found or is not published." : d.error ?? "Could not load the listing.");
      })
      .catch(() => setError("Could not load the listing."));
  }, [id]);

  const back = <p><a href="/listings">Back to listings</a></p>;

  if (error) return <main>{back}<p role="alert">{error}</p></main>;
  if (!listing) return <main>{back}<p className="muted" role="status">Loading...</p></main>;
  if (listing.status !== "published") {
    return (
      <main>
        {back}
        <p role="status">This listing is not published yet.</p>
        <p><a href={`/listings/${listing.id}/edit`}>Edit this draft</a></p>
      </main>
    );
  }

  const provided = listing.disclosures.filter(d => d.satisfied);
  const tx = listing.transactionType as "sale" | "rent";

  return (
    <main className="detail">
      <p className="detail-back"><a href="/listings">Back to listings</a></p>
      <div className="detail-layout">
        <div className="detail-main">
          <Gallery listingId={listing.id} title={listing.title} />
          <p><span className="lcard-tag detail-tag">{tx === "sale" ? "For sale" : "For rent"}</span></p>
          <h1>{listing.title}</h1>
          <p className="detail-address">{listing.address}</p>
          {listing.priceCents !== undefined && <p className="detail-price detail-price-m">{formatPrice(listing.priceCents, tx)}</p>}
          <ul className="chips detail-chips" aria-label="Features">
            {listing.bedrooms !== undefined && <li className="chip chip-bed">{listing.bedrooms} bed</li>}
            {listing.bathrooms !== undefined && <li className="chip chip-bath">{listing.bathrooms} bath</li>}
            {listing.parking !== undefined && <li className="chip chip-car">{listing.parking} car</li>}
          </ul>
          <h2>Property details</h2>
          <dl className="details detail-facts">
            <dt>State</dt><dd>{listing.jurisdiction}</dd>
            <dt>Offer</dt><dd>{tx === "sale" ? "For sale" : "For rent"}</dd>
            <dt>Use</dt><dd>{cap(listing.useClass)}</dd>
            <dt>Property</dt><dd>{cap(listing.propertyType)}</dd>
            {listing.suburb && <><dt>Suburb</dt><dd>{listing.suburb}{listing.postcode ? ` ${listing.postcode}` : ""}</dd></>}
            {listing.bedrooms !== undefined && <><dt>Bedrooms</dt><dd>{listing.bedrooms}</dd></>}
            {listing.bathrooms !== undefined && <><dt>Bathrooms</dt><dd>{listing.bathrooms}</dd></>}
            {listing.parking !== undefined && <><dt>Parking</dt><dd>{listing.parking}</dd></>}
          </dl>
          {provided.length > 0 && (
            <section aria-label="Disclosures">
              <h2>Disclosures provided</h2>
              <ul className="plain-list">{provided.map(d => <li key={d.key}>{cap(d.key)}</li>)}</ul>
            </section>
          )}
        </div>
        <aside className="detail-aside" aria-label="Contact the owner">
          {listing.priceCents !== undefined && <p className="detail-price">{formatPrice(listing.priceCents, tx)}</p>}
          <div className="detail-actions">
            <a className="button" href={actionHref(listing.id, "enquire", userType !== null)}>Enquire</a>
            <SaveButton listingId={listing.id} userType={userType} />
          </div>
          <p className="detail-note">You deal directly with the owner. Any deposit is paid to the owner&apos;s solicitor, never to the platform.</p>
        </aside>
      </div>
    </main>
  );
}
