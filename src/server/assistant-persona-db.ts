import { randomUUID } from "node:crypto";
import { DEFAULT_PERSONA_ID, isPersonaId, type PersonaId } from "../domain/assistant-persona";
import type { StaffActor } from "../domain/staff-access";
import { getDb } from "./context";
import { appendAuditPg, type Queryable } from "./db";

/**
 * The assistant's character. Insert-only: every change is a new row; the live choice is the latest row (the default when there is none).
 * Constant SQL with bound parameters; the id is checked against the fixed list before it reaches this layer and again by the table.
 */
export interface PersonaChoiceRow { persona: PersonaId; chosenBy: string; chosenAt: string }
export interface PersonaView { current: PersonaId; history: PersonaChoiceRow[] }

const LOCK = `SELECT pg_advisory_xact_lock(hashtext('assistant_persona_choice'))`;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const asPersona = (v: unknown): PersonaId => (isPersonaId(v) ? v : DEFAULT_PERSONA_ID);

export async function loadLivePersona(db: Queryable): Promise<PersonaId> {
  const r = await db.query(`SELECT persona FROM assistant_persona_choice ORDER BY id DESC LIMIT 1`);
  return asPersona(r.rows[0]?.["persona"]);
}

export async function loadPersonaView(db: Queryable): Promise<PersonaView> {
  const rows = (await db.query(
    `SELECT c.persona, COALESCE(u.display_name, u.email::text, c.chosen_by::text) AS chosen_by, c.chosen_at
       FROM assistant_persona_choice c LEFT JOIN app_user u ON u.id = c.chosen_by
      ORDER BY c.id DESC LIMIT 20`
  )).rows;
  const history = rows.map(r => ({ persona: asPersona(r["persona"]), chosenBy: String(r["chosen_by"]), chosenAt: iso(r["chosen_at"]) }));
  return { current: history[0]?.persona ?? DEFAULT_PERSONA_ID, history };
}

/** Makes `persona` live now. Choosing the one already live writes nothing. */
export async function choosePersona(db: Queryable, staff: StaffActor, persona: PersonaId): Promise<{ changed: boolean }> {
  if (!db.transaction) throw new Error("Transactions are required.");
  const out = await db.transaction(async tx => {
    await tx.query(LOCK);
    const previous = await loadLivePersona(tx);
    if (previous === persona) return { changed: false };
    await tx.query(`INSERT INTO assistant_persona_choice (persona, chosen_by) VALUES ($1, $2)`, [persona, staff.id]);
    await appendAuditPg(tx, {
      id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: staff.id, aggregateType: "assistant_persona",
      aggregateId: persona, eventType: "assistant.persona_changed", correlationId: randomUUID(), payload: { role: staff.role, persona, previous }
    });
    return { changed: true };
  });
  if (out.changed) clearPersonaCache();
  return out;
}

// ---- Cache for the public site, like the guide content: about 45 seconds; any failure gives the default, shortly cached. ----
const g = globalThis as unknown as { __olPersonaCache?: { at: number; ttl: number; value: PersonaId } | null };
export const clearPersonaCache = () => { g.__olPersonaCache = null; };

export async function getLivePersona(db: () => Queryable = getDb, now: number = Date.now()): Promise<PersonaId> {
  const c = g.__olPersonaCache;
  if (c && now - c.at < c.ttl) return c.value;
  let value: PersonaId, ttl = 45_000;
  try { value = await loadLivePersona(db()); } catch { value = DEFAULT_PERSONA_ID; ttl = 10_000; }
  g.__olPersonaCache = { at: now, ttl, value };
  return value;
}
