import type { Catalog } from "../domain/i18n";
import { FA } from "./fa";

export const CATALOGS: Readonly<Record<string, Catalog>> = { fa: FA };

/** Languages whose catalogue a native speaker has approved. Empty on purpose: add "fa" only after john's review. */
export const REVIEWED_LOCALES: readonly string[] = [];
