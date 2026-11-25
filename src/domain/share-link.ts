/** Public address of a listing on the site's own domain. */
export function listingShareUrl(origin: string, listingId: string): string {
  return `${origin.replace(/\/+$/, "")}/listings/${encodeURIComponent(listingId)}`;
}
