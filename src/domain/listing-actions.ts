import { safeNext } from "../server/auth/safe-next";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ListingAction = "enquire" | "save";

/** Where a listing action leads once the visitor is signed in. Null for a malformed listing id. */
export function actionPath(listingId: string, action: ListingAction): string | null {
  if (!UUID.test(listingId)) return null;
  return action === "enquire" ? `/listings/${listingId}/enquire` : `/listings/${listingId}`;
}

/**
 * Link for an Enquire or Save button. Signed-in visitors go straight to the action; signed-out visitors go to buyer sign-in
 * with the action as the `next` return path. `next` is checked with the same allowlist the server uses, so it can never be
 * an off-site or scheme URL; if it fails the check the visitor is sent to sign-in with no return path.
 */
export function actionHref(listingId: string, action: ListingAction, signedIn: boolean): string {
  const path = actionPath(listingId, action);
  if (path === null) return "/listings";
  if (signedIn) return path;
  const next = safeNext(path);
  return next ? `/api/auth/google/start?as=buyer&next=${next}` : "/api/auth/google/start?as=buyer";
}

export interface PublicDocLike { id: string; kind: string; visibility: string; status: string }

/** Photos shown in the public gallery: active, public photo files only. Private, superseded and other kinds are dropped. */
export function publicPhotos<T extends PublicDocLike>(docs: readonly T[]): T[] {
  return docs.filter(d => d.visibility === "public" && d.status === "active" && (d.kind === "photo" || d.kind === "photo_360"));
}
