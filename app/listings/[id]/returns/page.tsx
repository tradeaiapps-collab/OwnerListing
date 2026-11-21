"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import ReturnsCalc from "../../../returns-calc";

type L = { title: string; address: string; transactionType: "sale" | "rent"; priceCents?: number };

/** Owner view: see what your own listing looks like to an investor, and test other prices before you set one. */
export default function ListingReturnsPage() {
  const { id } = useParams<{ id: string }>();
  const [l, setL] = useState<L | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch(`/api/listings/${id}`).then(async r => {
      if (!r.ok) { setError(r.status === 401 ? "Sign in to use the calculator." : "Could not load this listing."); return; }
      setL((await r.json()).listing);
    }).catch(() => setError("Could not load this listing."));
  }, [id]);
  return (
    <main>
      <h1>Returns calculator</h1>
      {error && <p role="alert">{error}</p>}
      {!error && !l && <p className="muted" role="status">Loading...</p>}
      {l && (
        <>
          <p className="muted">{l.title} · {l.address}. Change any figure to test a different price or rent. Buyers see the same calculator on your public listing.</p>
          {l.priceCents === undefined && <p className="empty">This listing has no price yet, so the figures start from an example. <a href={`/listings/${id}/edit`}>Add a price</a>.</p>}
          {l.transactionType === "sale"
            ? <ReturnsCalc kind="property" price={l.priceCents !== undefined ? l.priceCents / 100 : undefined} />
            : <ReturnsCalc kind="property" weeklyRent={l.priceCents !== undefined ? l.priceCents / 100 : undefined} />}
        </>
      )}
      <p><a href="/listings/mine">Back to my listings</a></p>
    </main>
  );
}
