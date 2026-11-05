import type { ReactNode } from "react";
import { personaById } from "../../src/domain/assistant-persona";
import { getLivePersona } from "../../src/server/assistant-persona-db";
import { PersonaProvider } from "./persona-context";

export const metadata = { title: "Browse listings" };

export default async function Layout({ children }: { children: ReactNode }) {
  // A persona lookup failure must never break browsing: fall back to the default persona.
  const persona = personaById(await getLivePersona().catch(() => null));
  return <PersonaProvider value={{ name: persona.name, icon: persona.icon }}>{children}</PersonaProvider>;
}
