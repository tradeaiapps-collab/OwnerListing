import type { Catalog } from "../domain/i18n";
import { FA } from "./fa";

export const CATALOGS: Readonly<Record<string, Catalog>> = { fa: FA };

/** Languages whose catalogue a native speaker has approved. Persian approved by john on 22 Nov 2026. */
export const REVIEWED_LOCALES: readonly string[] = ["fa"];

/** A language can be switched on only if its catalogue exists and has been approved. English is always on. */
export const canEnableLocale = (code: string): boolean => REVIEWED_LOCALES.includes(code) && code in CATALOGS;
