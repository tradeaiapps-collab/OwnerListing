"use client";
import { createContext, useContext, type ReactNode } from "react";

export interface SearchPersona { name: string; icon: string }
const Ctx = createContext<SearchPersona>({ name: "Elena", icon: "/assistant/elena-icon.png" });

/** The assistant persona staff chose (Elena by default), for the search help panel. */
export function PersonaProvider({ value, children }: { value: SearchPersona; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useSearchPersona = () => useContext(Ctx);
