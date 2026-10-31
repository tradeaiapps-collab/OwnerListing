import { readBrand } from "../../src/config/brand";
import { personaById, personaPose } from "../../src/domain/assistant-persona";
import { readAppMode } from "../../src/config/app-mode";
import { getLivePersona } from "../../src/server/assistant-persona-db";
import { getLiveGuide } from "../../src/server/guide-assistant-db";
import Dashboard, { type DashboardAssistant } from "./dashboard-view";

/** Server shell: looks up the live assistant (the chat it opens only exists on the public site, with the guide switched on). */
export default async function Page() {
  let assistant: DashboardAssistant | null = null;
  if (readAppMode() !== "admin") {
    const [guide, personaId] = await Promise.all([getLiveGuide(), getLivePersona()]);
    const persona = personaById(personaId);
    if (guide.enabled) assistant = { name: persona.name, pose: personaPose(persona, "seated"), video: persona.id === "elena", brand: readBrand().name };
  }
  return <Dashboard assistant={assistant} />;
}
