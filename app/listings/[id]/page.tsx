"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { formatPrice } from "../../../src/domain/listing-details";
import "../../styles/documents.css";
import { actionHref, publicPhotos } from "../../../src/domain/listing-actions";
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
  if (images.length === 0 && links.length === 0) return null;
  return (
    <section aria-label="Photos and plans">
      <h2>Photos and plans</h2>
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

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

export default function ListingDetail() {
  const { id } = useParams<{ id: string }>();
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me").then(async r => setSignedIn(r.ok && (await r.json()).user !== null)).catch(() => setSignedIn(false));
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

  return (
    <main>
      {back}
      <h1>{listing.title}</h1>
      <p className="detail-address">{listing.address}</p>
      {listing.priceCents !== undefined && <p className="detail-price">{formatPrice(listing.priceCents, listing.transactionType as "sale" | "rent")}</p>}
      <div className="detail-actions">
        <a className="button" href={actionHref(listing.id, "enquire", signedIn)}>Enquire</a>
        <a className="button secondary" href={actionHref(listing.id, "save", signedIn)}>Save</a>
      </div>
      <Gallery listingId={listing.id} title={listing.title} />
      <dl className="details detail-facts">
        <dt>State</dt><dd>{listing.jurisdiction}</dd>
        <dt>Offer</dt><dd>{listing.transactionType === "sale" ? "For sale" : "For rent"}</dd>
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
    </main>
  );
}
