import { getDb } from "./context";
import { createPgSavedListingRepository } from "./saved-listing-db";

export const getSavedListingRepo = () => createPgSavedListingRepository(getDb());
