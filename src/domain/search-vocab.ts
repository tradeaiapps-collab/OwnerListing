import type { PropertyType } from "./listing";

/** Property types that only make sense as commercial. Mirrors the publish check in listing.ts. */
export const COMMERCIAL_TYPES: readonly PropertyType[] = ["office", "retail", "industrial", "warehouse", "hospitality"];
