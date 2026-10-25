import { photoUrl, type CardPhoto } from "../../src/domain/listing-photos";

/** Card image area: cover photo (lazy, responsive), sale/rent tag and photo-count badge. Falls back to the house icon. */
export function CardMedia({ photo, transactionType }: { photo: CardPhoto | undefined; transactionType: "sale" | "rent" }) {
  const cover = photo?.cover;
  const count = photo?.photoCount ?? 0;
  return (
    <div className={cover ? "lcard-media has-photo" : "lcard-media"}>
      {cover && (
        // Decorative here: the card's title link names the listing.
        <img src={photoUrl(cover.id)} srcSet={cover.srcSet || undefined} sizes="(min-width: 960px) 360px, (min-width: 600px) 50vw, 100vw"
          width={cover.width} height={cover.height} loading="lazy" decoding="async" alt="" />
      )}
      <span className="lcard-tag">{transactionType === "sale" ? "For sale" : "For rent"}</span>
      {count > 0 && <span className="lcard-count"><span className="sr-only">Photos: </span>{count}</span>}
    </div>
  );
}
