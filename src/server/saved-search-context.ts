import { getDb } from "./context";
import { createPgSavedSearchRepository } from "./saved-search-db";

/** Kept apart from context.ts so the shared wiring file is not touched. */
export const getSavedSearchRepo = () => createPgSavedSearchRepository(getDb());
