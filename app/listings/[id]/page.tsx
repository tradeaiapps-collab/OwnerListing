"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

interface Listing {
  id: string;
  title: string;
  address: string;
  jurisdiction: string;
  transactionType: string;
  useClass: string;
  propertyType: string;
  status: string;
  disclosures: { key: string; satisfied: boolean }[];
  updatedAt: string;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

export default function ListingDetail() {
  const { id } = useParams<{ id: string }>();
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");

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
      <p>{listing.address}</p>
      <dl className="details">
        <dt>State</dt><dd>{listing.jurisdiction}</dd>
        <dt>Offer</dt><dd>{listing.transactionType === "sale" ? "For sale" : "For rent"}</dd>
        <dt>Use</dt><dd>{cap(listing.useClass)}</dd>
        <dt>Property</dt><dd>{cap(listing.propertyType)}</dd>
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
