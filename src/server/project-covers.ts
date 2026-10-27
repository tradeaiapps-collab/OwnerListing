import { cardPhoto, type CardPhoto } from "../domain/listing-photos";
import { getDb } from "./context";
import { createPgProjectPhotoStore } from "./project-photos-db";

/** Adds each project's cover photo and photo count for the cards. Only for callers who may already see these projects. A read error means no photos. */
export async function withCovers<T extends { id: string }>(items: readonly T[]): Promise<(T & { photo: CardPhoto })[]> {
  let covers: Awaited<ReturnType<ReturnType<typeof createPgProjectPhotoStore>["coversFor"]>> = new Map();
  try { covers = await createPgProjectPhotoStore(getDb()).coversFor(items.map(i => i.id)); } catch { /* cards show the placeholder */ }
  return items.map(i => ({ ...i, photo: cardPhoto(covers.get(i.id), "/api/investments/photos") }));
}
