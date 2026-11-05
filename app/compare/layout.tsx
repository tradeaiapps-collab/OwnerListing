import type { ReactNode } from "react";
import { personaById } from "../../src/domain/assistant-persona";
import { getLivePersona } from "../../src/server/assistant-persona-db";
import { PersonaProvider } from "../listings/persona-context";

export const metadata = { title: "Compare properties" };

export default async function Layout({ children }: { children: ReactNode }) {
  const persona = personaById(await getLivePersona().catch(() => null));
  return <PersonaProvider value={{ name: persona.name, icon: persona.icon }}>{children}</PersonaProvider>;
}
