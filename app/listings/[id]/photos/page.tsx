"use client";
import { useParams } from "next/navigation";
import { PhotoManager } from "../../photo-manager";

/** Owner photo manager for any of the owner's listings (drafts and published ones). */
export default function ListingPhotos() {
  const { id } = useParams<{ id: string }>();
  return (
    <main>
      <p><a href="/listings/mine">Back to my listings</a> · <a href={`/listings/${id}`}>View listing</a></p>
      <h1>Listing photos</h1>
      <PhotoManager listingId={id} />
    </main>
  );
}
