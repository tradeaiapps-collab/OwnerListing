"use client";
import { createContext, useContext, type ReactNode } from "react";
import type { Catalog } from "../src/domain/i18n";

const Ctx = createContext<Catalog | undefined>(undefined);

/** Gives pages the live catalogue (none while a language is a draft or switched off, so English shows). */
export function I18nProvider({ catalog, children }: { catalog?: Catalog; children: ReactNode }) {
  return <Ctx.Provider value={catalog}>{children}</Ctx.Provider>;
}

/** t("English text") returns the translation, or the English text itself when there is none. Never blank. */
export function useT(): (text: string) => string {
  const c = useContext(Ctx);
  return text => c?.[text] ?? text;
}
